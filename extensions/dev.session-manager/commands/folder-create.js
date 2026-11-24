export async function createNamedFolder(options, { selectedFolderId, readAccount, prompt, create }) {
  const parentId = String(options?.parentId || selectedFolderId || "root");
  const account = readAccount();
  const supplied = String(options?.title || "").trim();
  const title = supplied || String(await prompt() || "").trim();
  if (!title) return null;
  const current = readAccount();
  if (["user", "space"].some(key => current?.[key]?.id !== account?.[key]?.id)
    || current?.sessionId !== account?.sessionId) return null;
  const id = await create(parentId, title);
  return { id, parentId };
}
