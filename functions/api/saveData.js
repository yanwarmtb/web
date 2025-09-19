// functions/api/saveData.js
// Endpoint: POST /api/saveData
// Body: { tanggal, kelas, data: [...] }

const DEFAULT_REPO   = "mrdickymiswardi/server";
const DEFAULT_BRANCH = "main";

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

// normalisasi kelas → aman di path
function normKelas(k) {
  if (!k) return "";
  let v = String(k).trim().replace(/-/g, "_").replace(/[^A-Za-z0-9_]/g, "_");
  if (!/^kelas_/.test(v)) v = `kelas_${v}`;
  return v;
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });

export const onRequestOptions = () => json({}, 204);

export async function onRequestPost({ request, env }) {
  const TOKEN  = env.GITHUB_TOKEN;
  const REPO   = env.GITHUB_REPO   || DEFAULT_REPO;
  const BRANCH = env.GITHUB_BRANCH || DEFAULT_BRANCH;
  if (!TOKEN) return json({ error: "GITHUB_TOKEN tidak terpasang di environment." }, 500);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Body harus JSON." }, 400); }

  let { tanggal, kelas, data } = body || {};
  if (!tanggal || !kelas || !data) return json({ error: "Data tidak lengkap" }, 400);

  kelas = normKelas(kelas);
  const fileName = `${kelas}_${tanggal}.json`;
  const baseUrl = `https://api.github.com/repos/${REPO}/contents/absensi/${encodeURIComponent(fileName)}`;

  const ghHeaders = {
    Authorization: `Bearer ${TOKEN}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "cf-pages-saveData/1.1",
  };

  // --- GET lama (ambil sha jika ada)
  let sha = null;
  let existingData = [];
  const getRes = await fetch(`${baseUrl}?ref=${encodeURIComponent(BRANCH)}`, { headers: ghHeaders });
  if (getRes.status === 200) {
    const meta = await getRes.json();
    sha = meta.sha;
    try { existingData = JSON.parse(b64decode(meta.content || "")) || []; } catch { existingData = []; }
  } else if (getRes.status !== 404) {
    const t = await getRes.text().catch(() => "");
    return json({ source: "github", step: "get", status: getRes.status, error: t || getRes.statusText }, 502);
  }

  // --- Merge data baru + audio lama
  const safeArr = Array.isArray(data) ? data : [];
  const mergedData = safeArr.map(newItem => {
    const oldItem = (existingData || []).find(e => String(e.id) === String(newItem.id)) || {};
    const oldMarks = oldItem.marks || {};
    const newMarks = newItem.marks || {};
    const audio = Array.isArray(oldMarks.audio) ? [...oldMarks.audio] : [];
    if (Array.isArray(newMarks.audio)) for (const a of newMarks.audio) if (!audio.includes(a)) audio.push(a);
    return { ...oldItem, ...newItem, marks: { ...newMarks, audio } };
  });

  const contentB64 = b64encode(JSON.stringify(mergedData, null, 2));

  // --- PUT dengan retry (untuk konflik 409/422)
  async function tryPut(currentSha) {
    const res = await fetch(baseUrl, {
      method: "PUT",
      headers: ghHeaders,
      body: JSON.stringify({
        message: `Update data absensi ${kelas} tanggal ${tanggal}`,
        content: contentB64,
        sha: currentSha || undefined,
        branch: BRANCH,
      }),
    });
    return res;
  }

  let putRes = await tryPut(sha);

  // konflik? refresh sha lalu coba sekali lagi
  if (putRes.status === 409 || putRes.status === 422) {
    const refRes = await fetch(`${baseUrl}?ref=${encodeURIComponent(BRANCH)}`, { headers: ghHeaders });
    if (refRes.status === 200) {
      const meta = await refRes.json();
      const freshSha = meta.sha;
      putRes = await tryPut(freshSha);
    }
  }

  if (!putRes.ok) {
    const t = await putRes.text().catch(() => "");
    // kirim balik detail agar terlihat di Network tab
    return json({
      source: "github",
      step: "put",
      status: putRes.status,
      error: t || putRes.statusText,
      hint: "Cek permission token, branch protection, atau konflik file yang baru saja berubah.",
      file: `absensi/${fileName}`,
    }, 502);
  }

  return json({ success: true }, 200);
}

export async function onRequest(ctx) {
  const m = ctx.request.method.toUpperCase();
  if (!["POST", "OPTIONS"].includes(m)) return json({ message: "Method Not Allowed" }, 405);
}
