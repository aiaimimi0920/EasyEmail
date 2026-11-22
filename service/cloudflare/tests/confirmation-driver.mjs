import assert from 'node:assert/strict';
import { afterEach } from 'node:test';

const observers = new Set();
afterEach(async () => {
  const pending = [...observers]; observers.clear();
  await Promise.all(pending.map(async observer => {
    if (!observer.page.isClosed()) await observer.page.close();
    await observer.task;
  }));
  for (const observer of pending) if (observer.error) throw observer.error;
});

async function respond(page, inspect) {
  const dialog = page.getByRole('alertdialog');
  await dialog.waitFor({ state: 'visible', timeout: 10000 });
  const message = await dialog.textContent();
  const key = await dialog.evaluate(el => el.querySelector('[data-confirmation-request]')?.getAttribute('data-confirmation-request'));
  let action;
  await inspect({
    message: () => message,
    accept: () => action = dialog.getByRole('button', { name: '确认', exact: true }).click(),
    dismiss: () => action = dialog.getByRole('button', { name: '取消', exact: true }).click(),
  });
  assert.ok(action, 'The test must explicitly accept or cancel the visible confirmation');
  await action;
  await page.waitForFunction(previous => {
    const current = document.querySelector('[role="alertdialog"]');
    return !current || current.textContent !== previous.message
      || current.querySelector('[data-confirmation-request]')?.getAttribute('data-confirmation-request') !== previous.key;
  }, { message, key });
}

// Starts the actual UI action and handles an explicit, ordered number of prompts.
// No window.confirm replacement or application API shortcuts are involved.
export async function confirmAction(page, action, steps) {
  const answers = (async () => {
    for (const step of Array.isArray(steps) ? steps : [steps]) await respond(page, step);
  })();
  const [result] = await Promise.all([action(), answers]);
  return result;
}

// Long business scenarios opt into a DOM observer for their lifetime, just as
// their old native-dialog fixture did. Browser teardown stops the pending wait.
// Assertion failures propagate as test failures, never as implicit acceptance.
export function observeConfirmations(page, inspect) {
  const observer = { page, task: null, error: null };
  observer.task = (async () => {
    while (!page.isClosed()) {
      try {
        await page.getByRole('alertdialog').waitFor({ timeout: 0 });
        await respond(page, inspect);
      }
      catch (error) {
        if (page.isClosed() && error.code !== 'ERR_ASSERTION' && /Target page, context or browser has been closed/.test(error.message)) return;
        throw error;
      }
    }
  })().catch(error => { observer.error = error; });
  observers.add(observer);
  return observer.task;
}
