export function downloadBrowserFile(name: string, data: BlobPart, type = "application/octet-stream") {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function pickBrowserBackup() {
  return new Promise<File | null>((resolve) => {
    const picker = document.createElement("input");
    picker.type = "file";
    picker.accept = ".json,application/json";
    picker.hidden = true;
    const done = () => {
      const selected = picker.files?.[0] ?? null;
      picker.remove();
      resolve(selected);
    };
    picker.addEventListener("change", done, { once: true });
    picker.addEventListener("cancel", done, { once: true });
    document.body.appendChild(picker);
    picker.click();
  });
}
