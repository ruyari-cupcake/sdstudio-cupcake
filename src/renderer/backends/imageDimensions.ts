export default function getImageDimensions(
  base64: string,
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const { width } = img;
      const { height } = img;
      resolve({ width, height });
    };
    img.onerror = reject;
    img.src = `data:image/png;base64,${base64}`;
  });
}
