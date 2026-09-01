import "node:process";
import express from "express";
import cors from "cors";
import { FkAttendTcpClient } from "./fkAttendTcp.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "8mb" }));

const port = Number(process.env.PORT ?? 3001);
const defaultHost = process.env.DEVICE_HOST ?? "192.168.1.215";
const defaultDevicePort = Number(process.env.DEVICE_PORT ?? 5006);
// JPEG profile-photo uploads use F2/F3 and are distinct from the device's
// biometric face enrollment flag. This in-memory set reflects successful
// uploads during the current backend session.
const uploadedProfilePhotos = new Set<number>();

function device(body: Record<string, unknown> = {}) {
  const host = typeof body.host === "string" && body.host.trim() ? body.host.trim() : defaultHost;
  const devicePort = Number(body.port ?? defaultDevicePort);
  if (!Number.isInteger(devicePort) || devicePort < 1 || devicePort > 65535) throw new Error("Geçersiz cihaz portu");
  return new FkAttendTcpClient(host, devicePort);
}

app.get("/api/config", (_req, res) => res.json({ host: defaultHost, port: defaultDevicePort }));

app.post("/api/device/test", async (req, res) => {
  const client = device(req.body ?? {});
  try { await client.connect(); await client.ping(); res.json({ ok: true, message: "Cihaz bağlantısı başarılı" }); }
  catch (error) {
    console.error("[device:test] TCP connection failed", { host: req.body?.host ?? defaultHost, port: req.body?.port ?? defaultDevicePort, error });
    res.status(502).json({ ok: false, message: error instanceof Error ? error.message : "Cihaza bağlanılamadı" });
  }
  finally { client.disconnect(); }
});

app.get("/api/device/overview", async (req, res) => {
  const client = device(req.query as Record<string, unknown>);
  try {
    await client.connect();
    await client.ping();
    // FKAttend permits one request at a time on a connection.
    const time = await client.getDeviceTime();
    const version = await client.getDeviceVersion();
    const managers = await client.getDeviceStatus(1);
    const users = await client.getDeviceStatus(2);
    const fingerprints = await client.getDeviceStatus(3);
    const passwords = await client.getDeviceStatus(4);
    const attendanceLogs = await client.getDeviceStatus(8);
    const machineNumber = await client.getDeviceInfo(2);
    const lockControl = await client.getDeviceInfo(5);
    const logWarning = await client.getDeviceInfo(6);
    const verifyInterval = await client.getDeviceInfo(8);
    res.json({ ok: true, time, version, status: { managers, users, fingerprints, passwords, attendanceLogs }, settings: { machineNumber, lockControl, logWarning, verifyInterval } });
  } catch (error) { res.status(502).json({ ok: false, message: error instanceof Error ? error.message : "Cihaz bilgileri okunamadı" }); }
  finally { client.disconnect(); }
});

app.post("/api/device/time", async (req, res) => {
  const { year, month, day, hour, minute, second } = req.body ?? {};
  const values = [year, month, day, hour, minute, second];
  if (!values.every(Number.isInteger)) return res.status(400).json({ message: "Tarih ve saat alanları tam sayı olmalı" });
  const client = device(req.body ?? {});
  try {
    await client.connect();
    await client.ping();
    const time = await client.setDeviceTime({ year, month, day, hour, minute, second });
    res.json({ ok: true, time, message: "Cihaz saati güncellendi." });
  } catch (error) { res.status(502).json({ ok: false, message: error instanceof Error ? error.message : "Cihaz saati güncellenemedi" }); }
  finally { client.disconnect(); }
});

app.post("/api/device/control", async (req, res) => {
  const { action } = req.body ?? {};
  if (action !== "enable" && action !== "disable" && action !== "door-open" && action !== "door-close" && action !== "door-auto") {
    return res.status(400).json({ message: "Geçersiz cihaz komutu" });
  }
  const client = device(req.body ?? {});
  try {
    await client.connect(); await client.ping();
    if (action === "enable") await client.setDeviceEnabled(true);
    if (action === "disable") await client.setDeviceEnabled(false);
    if (action === "door-open") await client.setDoorStatus(1);
    if (action === "door-close") await client.setDoorStatus(2);
    if (action === "door-auto") await client.setDoorStatus(3);
    const messages: Record<string, string> = { enable: "Cihaz etkinleştirildi", disable: "Cihaz devre dışı bırakıldı", "door-open": "Kapı açma komutu gönderildi", "door-close": "Kapı kapatma komutu gönderildi", "door-auto": "Kapı otomatik kapanma moduna alındı" };
    res.json({ ok: true, message: messages[action] });
  } catch (error) { res.status(502).json({ ok: false, message: error instanceof Error ? error.message : "Cihaz komutu gönderilemedi" }); }
  finally { client.disconnect(); }
});

app.post("/api/users", async (req, res) => {
  const { enrollNumber, password, name, privilege = 0 } = req.body ?? {};
  if (!Number.isInteger(enrollNumber) || enrollNumber < 1) return res.status(400).json({ message: "Kullanıcı ID'si pozitif bir tam sayı olmalı" });
  if (!Number.isInteger(password) || password < 1 || password > 0xffffffff) return res.status(400).json({ message: "PIN 1 ile 4294967295 arasında olmalı" });
  if (typeof name !== "string" || !name.trim()) return res.status(400).json({ message: "Kullanıcı adı zorunlu" });
  const client = device(req.body ?? {});
  try {
    await client.connect(); await client.ping();
    await client.createPasswordUser(enrollNumber, password, name.trim(), privilege === 1 ? 1 : 0);
    // Some XFace43 firmware versions accept C8 (write name) but reject C7
    // (read name). A failed read-back must not turn a completed enrollment
    // write into a false failure.
    let verifiedName: string | null = null;
    let verificationWarning: string | undefined;
    try {
      verifiedName = await client.getUserName(enrollNumber);
      if (!verifiedName) verificationWarning = "Kullanıcı eklendi, fakat cihaz kullanıcı adını geri döndürmedi.";
    } catch (error) {
      verificationWarning = error instanceof Error
        ? `Kullanıcı eklendi, fakat cihaz doğrulama komutunu reddetti (${error.message}).`
        : "Kullanıcı eklendi, fakat cihaz doğrulama komutunu reddetti.";
    }
    // C8 yazma başarılı olsa da bazı firmware'ler hemen ardından C7 okumayı reddeder.
    // Bu durum eklemeyi başarısız saymamalıdır; listeleme ayrı bir bağlantıda yapılır.
    verificationWarning = undefined;
    res.status(201).json({
      ok: true,
      user: { enrollNumber, name: verifiedName ?? name.trim(), privilege: privilege === 1 ? 1 : 0 },
      verification: { verified: Boolean(verifiedName), warning: verificationWarning },
    });
  } catch (error) { res.status(502).json({ ok: false, message: error instanceof Error ? error.message : "Kullanıcı eklenemedi" }); }
  finally { client.disconnect(); }
});

app.get("/api/users", async (req, res) => {
  const client = device(req.query as Record<string, unknown>);
  try {
    await client.connect();
    await client.ping();
    const users = await client.getUsers();
    res.json({ ok: true, count: users.length, users: users.map(user => ({ ...user, profilePhoto: uploadedProfilePhotos.has(user.enrollNumber) })) });
  } catch (error) { res.status(502).json({ ok: false, message: error instanceof Error ? error.message : "Kullanıcılar okunamadı" }); }
  finally { client.disconnect(); }
});

app.patch("/api/users/:enrollNumber", async (req, res) => {
  const enrollNumber = Number(req.params.enrollNumber);
  const { name } = req.body ?? {};
  if (!Number.isInteger(enrollNumber) || enrollNumber < 1) return res.status(400).json({ message: "Geçersiz kullanıcı ID'si" });
  if (typeof name !== "string" || !name.trim()) return res.status(400).json({ message: "Kullanıcı adı zorunlu" });
  const client = device(req.body ?? {});
  try {
    await client.connect(); await client.ping();
    await client.setUserName(enrollNumber, name.trim());
    res.json({ ok: true, user: { enrollNumber, name: name.trim() }, message: `#${enrollNumber} kullanıcısının adı güncellendi.` });
  } catch (error) { res.status(502).json({ ok: false, message: error instanceof Error ? error.message : "Kullanıcı güncellenemedi" }); }
  finally { client.disconnect(); }
});

app.patch("/api/users/:enrollNumber/privilege", async (req, res) => {
  const enrollNumber = Number(req.params.enrollNumber);
  const privilege = Number(req.body?.privilege);
  if (!Number.isInteger(enrollNumber) || enrollNumber < 1) return res.status(400).json({ message: "Geçersiz kullanıcı ID'si" });
  if (privilege !== 0 && privilege !== 1) return res.status(400).json({ message: "Yetki 0 veya 1 olmalı" });
  const client = device(req.body ?? {});
  try { await client.connect(); await client.ping(); await client.setUserPrivilege(enrollNumber, privilege as 0 | 1); res.json({ ok: true, message: `#${enrollNumber} yetkisi ${privilege === 1 ? "admin" : "normal kullanıcı"} olarak güncellendi.` }); }
  catch (error) { res.status(502).json({ ok: false, message: error instanceof Error ? error.message : "Yetki güncellenemedi" }); }
  finally { client.disconnect(); }
});

app.patch("/api/users/:enrollNumber/password", async (req, res) => {
  const enrollNumber = Number(req.params.enrollNumber);
  const password = Number(req.body?.password);
  const privilege = Number(req.body?.privilege ?? 0);
  if (!Number.isInteger(enrollNumber) || enrollNumber < 1) return res.status(400).json({ message: "Geçersiz kullanıcı ID'si" });
  if (!Number.isInteger(password) || password < 1 || password > 0xffffffff) return res.status(400).json({ message: "PIN 1 ile 4294967295 arasında olmalı" });
  const client = device(req.body ?? {});
  try {
    await client.connect(); await client.ping();
    await client.updatePassword(enrollNumber, password, privilege === 1 ? 1 : 0);
    res.json({ ok: true, message: `#${enrollNumber} kullanıcısının PIN'i güncellendi.` });
  } catch (error) { res.status(502).json({ ok: false, message: error instanceof Error ? error.message : "PIN güncellenemedi" }); }
  finally { client.disconnect(); }
});

app.delete("/api/users/:enrollNumber/password", async (req, res) => {
  const enrollNumber = Number(req.params.enrollNumber);
  if (!Number.isInteger(enrollNumber) || enrollNumber < 1) return res.status(400).json({ message: "Geçersiz kullanıcı ID'si" });
  const client = device(req.body ?? {});
  try {
    await client.connect(); await client.ping();
    await client.deletePassword(enrollNumber);
    res.json({ ok: true, message: "#" + enrollNumber + " için kullanıcı silme komutu gönderildi." });
  } catch (error) { res.status(502).json({ ok: false, message: error instanceof Error ? error.message : "Kullanıcı silinemedi" }); }
  finally { client.disconnect(); }
});

app.delete("/api/users/:enrollNumber/fingerprint", async (req, res) => {
  const enrollNumber = Number(req.params.enrollNumber);
  if (!Number.isInteger(enrollNumber) || enrollNumber < 1) return res.status(400).json({ message: "Geçersiz kullanıcı ID'si" });
  const client = device(req.body ?? {});
  try { await client.connect(); await client.ping(); await client.deleteFingerprint(enrollNumber); res.json({ ok: true, message: `#${enrollNumber} parmak izi silindi.` }); }
  catch (error) { res.status(502).json({ ok: false, message: error instanceof Error ? error.message : "Parmak izi silinemedi" }); }
  finally { client.disconnect(); }
});

app.delete("/api/users/:enrollNumber/face", async (req, res) => {
  const enrollNumber = Number(req.params.enrollNumber);
  if (!Number.isInteger(enrollNumber) || enrollNumber < 1) return res.status(400).json({ message: "Geçersiz kullanıcı ID'si" });
  const client = device(req.body ?? {});
  try {
    await client.connect(); await client.ping();
    await client.deleteFace(enrollNumber);
    res.json({ ok: true, message: "#" + enrollNumber + " kullanıcısının yüz kaydı silindi." });
  } catch (error) { res.status(502).json({ ok: false, message: error instanceof Error ? error.message : "Yüz kaydı silinemedi" }); }
  finally { client.disconnect(); }
});

app.post("/api/users/:enrollNumber/photo", async (req, res) => {
  const enrollNumber = Number(req.params.enrollNumber);
  const { photoBase64 } = req.body ?? {};
  if (!Number.isInteger(enrollNumber) || enrollNumber < 1) return res.status(400).json({ message: "Geçersiz kullanıcı ID'si" });
  if (typeof photoBase64 !== "string" || !photoBase64.trim()) return res.status(400).json({ message: "JPEG fotoğraf zorunlu" });
  const jpeg = Buffer.from(photoBase64.replace(/^data:image\/jpeg;base64,/i, ""), "base64");
  const client = device(req.body ?? {});
  try {
    await client.connect(); await client.ping();
    const directory = await client.getAllUserIds();
    if (!directory.some(user => user.enrollNumber === enrollNumber)) throw new Error("Fotoğraf yüklemeden önce kullanıcıyı PIN veya başka bir doğrulanmış kayıtla oluşturun.");
    await client.uploadUserPhoto(enrollNumber, jpeg);
    uploadedProfilePhotos.add(enrollNumber);
    res.status(201).json({ ok: true, message: "#" + enrollNumber + " kullanıcısının fotoğrafı yüklendi." });
  } catch (error) {
    console.error("[user:photo] F2/F3 upload failed", { host: req.body?.host ?? defaultHost, port: req.body?.port ?? defaultDevicePort, enrollNumber, error });
    res.status(502).json({ ok: false, message: error instanceof Error ? error.message : "Fotoğraf yüklenemedi" });
  }
  finally { client.disconnect(); }
});

app.get("/api/attendance", async (req, res) => {
  const client = device(req.query as Record<string, unknown>);
  try { await client.connect(); const requestedUserId = Number(req.query.userId); const records = Number.isInteger(requestedUserId) && requestedUserId > 0 ? await client.getLogsByUser(requestedUserId) : await client.getAttendanceRecords(); let names = new Map<number, string | null>(); try { const users = await client.getUsers(); names = new Map(users.map(user => [user.enrollNumber, user.name])); } catch { /* logs remain usable when a firmware rejects C7 name reads */ } const validRecords = names.size ? records.filter(record => names.has(record.employeeId)) : records; res.json({ count: validRecords.length, records: validRecords.map(({ raw, date, ...record }) => { const employeeId = record.employeeId; return { ...record, employeeId, name: names.get(employeeId) ?? null, date: date?.toISOString() ?? null, raw: raw.toString("hex") }; }) }); }
  catch (error) { res.status(502).json({ ok: false, message: error instanceof Error ? error.message : "Kayıtlar okunamadı" }); }
  finally { client.disconnect(); }
});

app.listen(port, () => console.log(`XFace43 panel backend http://localhost:${port}`));
