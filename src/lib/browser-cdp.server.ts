export async function browserCommand(url: string, action: "frame" | "input", input?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const socket = new WebSocket(url);
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  const timer = setTimeout(() => socket.close(), 15_000);
  const command = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(String(event.data));
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result ?? {});
    } catch {}
  });
  socket.addEventListener("close", () => {
    for (const waiter of pending.values()) waiter.reject(new Error("A böngésző kapcsolata megszakadt."));
    pending.clear();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("A böngésző nem érhető el.")), { once: true });
      socket.addEventListener("close", () => reject(new Error("A böngésző kapcsolata lezárult.")), { once: true });
    });
    const targets = await command("Target.getTargets");
    const pages = (targets.targetInfos as Array<{ type: string; targetId: string; url: string }>).filter((target) => target.type === "page");
    const page = pages.find((target) => !target.url.startsWith("chrome-extension:"));
    if (!page) throw new Error("Nincs megnyitott böngészőlap.");
    const attached = await command("Target.attachToTarget", { targetId: page.targetId, flatten: true });
    const sessionId = String(attached.sessionId);
    if (action === "frame") return { ...(await command("Page.captureScreenshot", { format: "jpeg", quality: 75, captureBeyondViewport: false }, sessionId)), url: page.url };
    if (!input) throw new Error("Hiányzó beviteli művelet.");
    const kind = input.kind;
    if (kind === "text") await command("Input.insertText", { text: input.text }, sessionId);
    else if (kind === "key") await command("Input.dispatchKeyEvent", { type: input.type, key: input.key, code: input.code, windowsVirtualKeyCode: input.keyCode, nativeVirtualKeyCode: input.keyCode, modifiers: input.modifiers }, sessionId);
    else await command("Input.dispatchMouseEvent", { type: input.type, x: input.x, y: input.y, button: input.button ?? "none", buttons: input.buttons ?? 0, clickCount: input.clickCount ?? 0, ...(kind === "wheel" ? { deltaX: input.deltaX, deltaY: input.deltaY } : {}) }, sessionId);
    return { ok: true };
  } finally {
    clearTimeout(timer);
    socket.close();
  }
}