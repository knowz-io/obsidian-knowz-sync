export async function contentHash(content: string): Promise<string> {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
