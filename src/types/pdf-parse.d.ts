declare module 'pdf-parse/lib/pdf-parse.js' {
  const pdfParse: (buffer: Buffer) => { text: string; numpages: number; info?: unknown };
  export default pdfParse;
}
