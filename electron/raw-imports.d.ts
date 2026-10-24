/** Vite `?raw` imports: the file's contents as a string. */
declare module "*?raw" {
  const content: string;
  export default content;
}

/** Vite `?inline` asset imports: the file as a base64 data URL. */
declare module "*?inline" {
  const dataUrl: string;
  export default dataUrl;
}
