/** FileReader completion, failure and cancellation share one settled owner. */
export function readImportFile(
  file: Blob,
  mode: 'text' | 'data-url',
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const cleanup = () => {
      reader.onload = null;
      reader.onerror = null;
      reader.onabort = null;
    };
    reader.onload = () => {
      const { result } = reader;
      cleanup();
      if (typeof result === 'string') resolve(result);
      else reject(new Error('파일 읽기 결과가 텍스트가 아닙니다.'));
    };
    reader.onerror = () => {
      const error = reader.error ?? new Error('파일을 읽지 못했습니다.');
      cleanup();
      reject(error);
    };
    reader.onabort = () => {
      cleanup();
      reject(new DOMException('파일 읽기를 취소했습니다.', 'AbortError'));
    };
    try {
      if (mode === 'text') reader.readAsText(file);
      else reader.readAsDataURL(file);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
