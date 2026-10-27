/** Pure data-URI conversion; safe for low-level helpers without loading app services. */
export function dataUriToBase64(dataUri: string) {
  return dataUri.split(',')[1];
}
