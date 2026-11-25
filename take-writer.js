// Writes a take to this site's private storage as it's recorded, so long 4K takes don't have to fit in memory
// and a take survives the app being closed. Messages are handled strictly in order.

let access = null, off = 0, writes = 0, chain = Promise.resolve();
const dir = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('takes', { create: true });
const done = async (v) => (v instanceof Promise ? v : v);   // early versions of these calls returned promises

async function handle(m) {
  if (m.type === 'probe') {
    const d = await dir();
    const fh = await d.getFileHandle('.probe', { create: true });
    const a = await fh.createSyncAccessHandle();
    await done(a.close());
    await d.removeEntry('.probe');
    return {};
  }
  if (m.type === 'open') {
    if (access) { try { await done(access.close()); } catch {} }
    const fh = await (await dir()).getFileHandle(m.name, { create: true });
    access = await fh.createSyncAccessHandle();
    await done(access.truncate(0));
    off = 0;
    return {};
  }
  if (m.type === 'chunk') {
    const buf = new Uint8Array(await m.blob.arrayBuffer());
    let n = 0;
    while (n < buf.length) {
      const wrote = await done(access.write(buf.subarray(n), { at: off + n }));
      if (!wrote) throw new Error('storage is full');
      n += wrote;
    }
    off += buf.length;
    await done(access.flush());   // commit each second, so a crash mid-take still leaves everything up to here
    return { bytes: off };
  }
  if (m.type === 'write') {
    // positioned write from the WebCodecs recorder
    const buf = m.data;
    let n = 0;
    while (n < buf.length) {
      const wrote = await done(access.write(buf.subarray(n), { at: m.position + n }));
      if (!wrote) throw new Error('storage is full');
      n += wrote;
    }
    off = Math.max(off, m.position + buf.length);
    if (++writes % 8 === 0) await done(access.flush());
    return { bytes: off };
  }
  if (m.type === 'close') {
    if (access) { await done(access.flush()); await done(access.close()); access = null; }
    return { bytes: off };
  }
  if (m.type === 'remove') {
    const d = await dir();
    for (const name of m.names) { try { await d.removeEntry(name); } catch {} }
    return {};
  }
  return {};
}

self.onmessage = (e) => {
  const m = e.data;
  chain = chain.then(() => handle(m)).then(
    (r) => postMessage({ id: m.id, ok: true, ...r }),
    (err) => postMessage({ id: m.id, ok: false, err: String(err?.message || err) }),
  );
};
