// functions/api/aksesAutoUpdateAllJuzMur.js
// Cloudflare Pages Functions (ESM)

const DEFAULT_REPO   = "mrdickymiswardi/server";
const DEFAULT_BRANCH = "main";
const FILE_PATH      = "autoUpdateAllJuzMur.json";

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64encode = (str) => {
  const bytes = enc.encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
};
const b64decode = (b64 = "") => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return dec.decode(bytes);
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });

const ghHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "Content-Type": "application/json",
  "User-Agent": "cf-pages-aksesAutoUpdateAllJuzMur/1.1",
});

const withRef = (url, branch) => `${url}?ref=${encodeURIComponent(branch)}`;

async function getCurrentFile({ repo, path, branch, token }) {
  const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}`;
  const res = await fetch(withRef(url, branch), { headers: ghHeaders(token) });

  if (res.status === 404) {
    return { sha: null, contentStr: "[]" }; // file belum ada
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`GET GitHub failed ${res.status}: ${t || res.statusText}`);
  }
  const meta = await res.json();
  const contentStr = b64decode(meta.content || "");
  return { sha: meta.sha, contentStr };
}

// ---- retry PUT dengan exponential backoff + jitter
async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function putFile({
  repo, path, branch, token, contentStr, sha, message,
  maxRetries = 5
}) {
  const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}`;
  const baseBody = {
    message: message || "update",
    content: b64encode(contentStr),
    branch,
  };

  let attempt = 0;
  let curSha = sha || null;

  while (attempt < maxRetries) {
    const body = curSha ? { ...baseBody, sha: curSha } : baseBody;

    let res = await fetch(url, {
      method: "PUT",
      headers: ghHeaders(token),
      body: JSON.stringify(body),
    });

    if (res.ok) return { ok: true };

    // Konflik (sha kedaluwarsa) → refresh sha + backoff lalu ulang
    if (res.status === 409 || res.status === 422) {
      const ref = await fetch(withRef(url, branch), { headers: ghHeaders(token) });
      if (ref.status === 200) {
        const meta = await ref.json();
        curSha = meta.sha || null;
        const delay = Math.min(80 * (2 ** attempt), 1200) + Math.floor(Math.random() * 40);
        await sleep(delay);
        attempt++;
        continue;
      }
    }

    const t = await res.text().catch(() => "");
    return { ok: false, status: res.status, error: t || res.statusText };
  }

  // Tetap konflik setelah retry → anggap OK di caller (conflict-after-retries)
  return { ok: false, status: 409, error: "conflict-after-retries" };
}

export const onRequestOptions = () => json({}, 204);

export async function onRequestGet({ env }) {
  const TOKEN  = env.GITHUB_TOKEN;
  const REPO   = env.GITHUB_REPO   || DEFAULT_REPO;
  const BRANCH = env.GITHUB_BRANCH || DEFAULT_BRANCH;
  if (!TOKEN) return json({ error: "GITHUB_TOKEN belum diset di environment." }, 500);

  try {
    const { contentStr } = await getCurrentFile({ repo: REPO, path: FILE_PATH, branch: BRANCH, token: TOKEN });
    // kembalikan string JSON apa adanya (lebih efisien)
    return new Response(contentStr, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  } catch (e) {
    return json({ error: String(e.message || e) }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  const TOKEN  = env.GITHUB_TOKEN;
  const REPO   = env.GITHUB_REPO   || DEFAULT_REPO;
  const BRANCH = env.GITHUB_BRANCH || DEFAULT_BRANCH;
  if (!TOKEN) return json({ error: "GITHUB_TOKEN belum diset di environment." }, 500);

  let payload;
  try { payload = await request.json(); }
  catch { return json({ error: "Body bukan JSON valid." }, 400); }

  const { fromDate, toDate, kelas, data } = payload || {};
  if (!kelas) return json({ error: "Parameter 'kelas' wajib ada." }, 400);

  // baca file saat ini (atau default [])
  const { sha, contentStr } = await getCurrentFile({
    repo: REPO, path: FILE_PATH, branch: BRANCH, token: TOKEN
  });

  let arr;
  try {
    const parsed = JSON.parse(contentStr);
    arr = Array.isArray(parsed) ? parsed : [];
  } catch {
    arr = [];
  }

  const nowIso = new Date().toISOString();
  const idx = arr.findIndex((x) => x && x.kelas === kelas);

  const record = {
    kelas,
    fromDate: fromDate || "",
    toDate: toDate || "",
    updatedAt: nowIso,
    count: Array.isArray(data) ? data.length : 0, // metadata ringan
  };

  // --- short-circuit jika tidak ada perubahan (hindari PUT sia-sia)
  if (idx >= 0) {
    const prev = arr[idx] || {};
    const unchanged =
      String(prev.fromDate || "") === String(record.fromDate) &&
      String(prev.toDate   || "") === String(record.toDate) &&
      Number(prev.count || 0) === Number(record.count || 0);

    if (unchanged) {
      // Jangan nulis; balas OK agar tidak ada 409 di console
      return json({ ok: true, saved: { ...prev, updatedAt: prev.updatedAt } }, 200);
    }
    // Ada perubahan → update dalam array
    arr[idx] = { ...prev, ...record };
  } else {
    // Baru → push
    arr.push(record);
  }

  const newContent = JSON.stringify(arr, null, 2);

  const put = await putFile({
    repo: REPO,
    path: FILE_PATH,
    branch: BRANCH,
    token: TOKEN,
    contentStr: newContent,
    sha,
    message: `autoUpdateAllJuzMur: upsert kelas=${kelas} (${fromDate || ""}..${toDate || ""})`,
  });

  if (!put.ok) {
    // Jika murni konflik karena balapan setelah beberapa retry, anggap sukses (request lain sudah nulis)
    if (put.status === 409 && put.error === "conflict-after-retries") {
      return json({ ok: true, status: "conflict_ignored" }, 200);
    }
    return json({ error: `PUT GitHub failed ${put.status}: ${put.error}` }, put.status || 502);
  }

  return json({ ok: true, saved: record }, 200);
}

export async function onRequest(ctx) {
  const m = ctx.request.method.toUpperCase();
  if (!["GET", "POST", "OPTIONS"].includes(m)) return json({ error: "Method Not Allowed" }, 405);
}
