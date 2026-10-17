import '@testing-library/jest-dom/vitest';

// jsdom's Blob lacks arrayBuffer()/text(); polyfill via FileReader.
function read<T>(blob: Blob, how: 'readAsArrayBuffer' | 'readAsText'): Promise<T> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as T);
    r.onerror = () => reject(r.error);
    r[how](blob);
  });
}
if (!Blob.prototype.arrayBuffer) Blob.prototype.arrayBuffer = function () { return read<ArrayBuffer>(this, 'readAsArrayBuffer'); };
if (!Blob.prototype.text) Blob.prototype.text = function () { return read<string>(this, 'readAsText'); };
