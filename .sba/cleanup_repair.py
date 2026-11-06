"""Independent repair of a write-before-blocked cleanup; never redeploy or bypass durable authority."""
from boundary import exact, matches, require, version


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


def repair_cleanup(request, directory):
    from preview_cleanup import destroy_preview
    # Original signed release/provenance, exact state and no consumed authority are
    # revalidated by the same cleanup implementation before its first conditional write.
    result = destroy_preview(cleanup_request(request), directory)
    if result['status'] == 'succeeded': result['checks'].append({'id': 'repair-completed', 'passed': True})
    return result
