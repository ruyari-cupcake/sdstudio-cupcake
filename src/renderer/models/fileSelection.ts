/** Keep the picker owner alive until the browser reports a selection or cancellation. */
export function getFirstFile(): Promise<File | undefined> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.style.display = 'none';
    let settled = false;
    const cleanup = () => {
      input.removeEventListener('change', onChange);
      input.removeEventListener('cancel', onCancel);
      input.remove();
    };
    const finish = (file?: File) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(file);
    };
    function onChange() {
      finish(input.files?.[0]);
    }
    function onCancel() {
      finish();
    }
    input.addEventListener('change', onChange);
    input.addEventListener('cancel', onCancel);
    try {
      document.body.appendChild(input);
      input.click();
    } catch (error) {
      settled = true;
      cleanup();
      reject(error);
    }
  });
}
