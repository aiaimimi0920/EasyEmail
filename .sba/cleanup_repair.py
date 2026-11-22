"""Independent repair of a write-before-blocked cleanup; never redeploy or bypass durable authority."""
from boundary import digest, exact, matches, require, version


def cleanup_request(request):
    original = request['context']['cleanup']
    return {**request, 'action': 'destroy-preview', 'sourceSha': original['sourceSha'],
            'applicationVersion': original['applicationVersion'],
            'previous': {key: original[key] for key in ('sourceSha', 'applicationVersion')}, 'context': original['context']}


def validate_cleanup(request, validate_context):
    context = request['context']; baseline = context['cleanup']
    require(context['repairId'] == 'complete-preview-cleanup' and 'preview' not in context and 'previewBaseline' not in context)
    exact(baseline, ['sourceSha', 'applicationVersion', 'context'])
    require(matches(r'[a-f0-9]{40}', baseline['sourceSha']) and baseline['sourceSha'] != request['sourceSha']
            and version(baseline['applicationVersion']) <= version(request['previous']['applicationVersion']))
    original = cleanup_request(request); validate_context(original)
    require(original['context']['previewTaskId'] not in (request['taskId'], context['parentTaskId'])
            and original['context']['instanceId'] not in (request['taskId'], context['parentTaskId']))
    if 'cleanupProgress' in context: validate_progress(request)


def validate_progress(request):
    context = request['context']; progress = context['cleanupProgress']
    exact(progress, ['consumedTaskId', 'permitAt', 'journalTaskId', 'parentResult'])
    parent = progress['parentResult']
    require(matches(r'dc-[a-f0-9]{32}', progress['consumedTaskId']) and progress['consumedTaskId'] != request['taskId'] and
            type(progress['permitAt']) is int and 0 < progress['permitAt'] <= 9007199254740991 and
            (progress['journalTaskId'] is None or matches(r'dc-[a-f0-9]{32}', progress['journalTaskId']) and progress['journalTaskId'] != request['taskId']))
    exact(parent, ['schemaVersion', 'taskId', 'action', 'sourceSha', 'applicationVersion', 'status', 'checks', 'errorCode'] + (['lifecycle'] if 'lifecycle' in parent else []))
    require(digest(parent) == context['resultDigest'] and parent['schemaVersion'] == 3 and parent['taskId'] == context['parentTaskId'] and
            parent['action'] in ('destroy-preview', 'repair') and parent['status'] in ('failed', 'unknown') and parent['errorCode'] == context['errorCode'] and
            all(parent[field] == request['previous'][field] for field in ('sourceSha', 'applicationVersion')))
    require(isinstance(parent['checks'], list) and len(parent['checks']) <= 30)
    for row in parent['checks']:
        exact(row, ['id', 'passed']); require(matches(r'[a-z][a-z0-9-]{1,62}', row['id']) and type(row['passed']) is bool)
    require(len({row['id'] for row in parent['checks']}) == len(parent['checks']))
    if 'lifecycle' in parent:
        exact(parent['lifecycle'], ['resources']); rows = parent['lifecycle']['resources']; resources = context['cleanup']['context']['resources']
        require(isinstance(rows, list) and len(rows) == len(resources) and {row['key'] for row in rows} == {row['key'] for row in resources})
        for row in rows:
            exact(row, ['key', 'status']); require(row['status'] in ('removed', 'absent', 'failed', 'unknown'))


def repair_cleanup(request, directory):
    if 'cleanupProgress' in request['context']:
        from cleanup_resume import resume_cleanup
        return resume_cleanup(request, cleanup_request(request), directory)
    from preview_cleanup import destroy_preview
    # Original signed release/provenance, exact state and no consumed authority are
    # revalidated by the same cleanup implementation before its first conditional write.
    result = destroy_preview(cleanup_request(request), directory)
    if result['status'] == 'succeeded': result['checks'].append({'id': 'repair-completed', 'passed': True})
    return result
