"use strict";

const crypto = require("node:crypto");
const {initializeApp} = require("firebase-admin/app");
const {getFirestore, FieldValue} = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();
const APP_KEY = {value: () => process.env.APP_ENCRYPTION_KEY || ""};
const BOOTSTRAP_KEY = {value: () => process.env.BOOTSTRAP_KEY || ""};
const SESSION_MS = 6 * 60 * 60 * 1000;
const COLLECTIONS = ["staff", "branches", "shifts", "timesheets", "leaves", "advances", "payroll_runs", "payroll_drafts", "security_deposit_ledger", "advance_offers", "settings", "audit_logs"];

const text = (value) => String(value == null ? "" : value).trim();
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const round = (value) => Math.round(number(value) * 100) / 100;
const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const secretKey = () => crypto.createHash("sha256").update(APP_KEY.value()).digest();
const pinLookup = (pin) => crypto.createHmac("sha256", secretKey()).update(String(pin)).digest("hex");
const pinHash = (pin, salt = crypto.randomBytes(16).toString("hex")) => `${salt}:${crypto.scryptSync(String(pin), salt, 64).toString("hex")}`;
const checkPin = (pin, stored) => {
  try {
    const [salt, hash] = text(stored).split(":");
    const actual = crypto.scryptSync(String(pin), salt, 64);
    return crypto.timingSafeEqual(actual, Buffer.from(hash, "hex"));
  } catch (_) { return false; }
};
const encrypt = (plain) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secretKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
};
const decrypt = (value) => {
  const [iv, tag, data] = String(value).split(".");
  const decipher = crypto.createDecipheriv("aes-256-gcm", secretKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
};

function bangkokParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"}).formatToParts(date);
  return Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
}
const today = (date = new Date()) => { const p = bangkokParts(date); return `${p.year}-${p.month}-${p.day}`; };
const bangkokWeekday = (date = new Date()) => new Intl.DateTimeFormat("en-US", {timeZone: "Asia/Bangkok", weekday: "short"}).format(date);
const nowTime = () => { const p = bangkokParts(); return `${p.hour}:${p.minute}`; };
const nowText = () => { const p = bangkokParts(); return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`; };
const id = (prefix) => `${prefix}${Date.now()}${crypto.randomInt(10, 100)}`;
const yesterday = () => today(new Date(Date.now() - 86400000));
const timeText = (value) => { const p = text(value).replace(".", ":").split(":"); return p.length === 2 ? `${p[0].padStart(2, "0")}:${p[1].padStart(2, "0")}` : text(value); };
const validTime = (value) => { const m = timeText(value).match(/^(\d{2}):(\d{2})$/); return Boolean(m && Number(m[1]) < 24 && Number(m[2]) < 60); };
const minutes = (value) => { const [h, m] = timeText(value).split(":").map(Number); return h * 60 + m; };
const minutesOvernight = (start, end) => { const a = minutes(start); let b = minutes(end); if (b < a) b += 1440; return b - a; };
const hours = (start, end) => round(minutesOvernight(start, end) / 60);
const lateMinutes = (actual, start) => { let diff = minutes(actual) - minutes(start); if (diff < -720) diff += 1440; return Math.max(0, diff); };
const overtimeMinutes = (clockIn, shiftEnd, clockOut) => { const start = minutes(clockIn); let end = minutes(shiftEnd); let out = minutes(clockOut); if (end <= start) end += 1440; if (out < start) out += 1440; return Math.max(0, out - end); };
const dateRange = (from, to) => {
  const result = [], start = new Date(`${from}T12:00:00Z`), end = new Date(`${to}T12:00:00Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) throw Error("ช่วงวันที่ไม่ถูกต้อง");
  for (let d = start; d <= end; d.setUTCDate(d.getUTCDate() + 1)) result.push(d.toISOString().slice(0, 10));
  return result;
};
const haversine = (a, b, c, d) => { const r = 6371000, p = (x) => x * Math.PI / 180, da = p(c - a), db = p(d - b), q = Math.sin(da / 2) ** 2 + Math.cos(p(a)) * Math.cos(p(c)) * Math.sin(db / 2) ** 2; return 2 * r * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q)); };

async function list(name) {
  const snap = await db.collection(name).get();
  return snap.docs.map((doc) => ({...doc.data(), _doc_id: doc.id}));
}
async function getById(name, value) {
  const snap = await db.collection(name).doc(String(value)).get();
  return snap.exists ? {...snap.data(), _doc_id: snap.id} : null;
}
async function timesheetForDate(staffId, date) {
  const snap = await db.collection("timesheets").where("staff_id", "==", String(staffId)).where("date", "==", String(date)).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return {...doc.data(), _doc_id: doc.id};
}
async function latestTimesheets(staffId, count = 3) {
  const snap = await db.collection("timesheets").where("staff_id", "==", String(staffId)).orderBy("date", "desc").limit(count).get();
  return snap.docs.map((doc) => ({...doc.data(), _doc_id: doc.id}));
}
async function settings() {
  const rows = await list("settings");
  return Object.fromEntries(rows.map((row) => [row.key || row._doc_id, String(row.value ?? "")]));
}
async function saveSetting(key, value, description = "") {
  await db.collection("settings").doc(String(key)).set({key: String(key), value: String(value ?? ""), description}, {merge: true});
}
const payrollDocId = (month, staffId) => `${month}_${staffId}`;
function sanitizeAdjustments(value) {
  if (!Array.isArray(value)) return [];
  if (value.length > 50) throw Error("รายการปรับยอดมากเกินไป");
  return value.map((row) => {
    const type = ["add", "deduct", "security_deposit"].includes(row?.type) ? row.type : "";
    const label = text(row?.label);
    const amount = round(Math.max(0, number(row?.amount)));
    if (!type || !label || amount <= 0) throw Error("กรุณากรอกชื่อและจำนวนเงินของทุกรายการ");
    return {adjustment_id: text(row.adjustment_id) || id("ADJ"), type, label, amount};
  });
}
async function securityDepositBalance(staff) {
  const rows = await list("security_deposit_ledger");
  return round(number(staff?.security_deposit_opening_balance) + rows.filter((row) => row.staff_id === staff?.staff_id).reduce((sum, row) => sum + number(row.amount), 0));
}
const MUTATING_ACTIONS = new Set(["clockIn", "clockOut", "requestSundayAdvance", "saveStaff", "saveBranch", "saveShift", "saveSettings", "saveTelegram", "bulkUpsertTimesheets", "saveLeave", "saveAdvance", "approveOT", "savePayrollDraft", "updateTimesheet", "finalizePayrollPerson", "reopenPayrollPerson", "deleteAdminRecord", "importData"]);
const ACTION_LABELS = {clockIn: "บันทึกเข้างาน", clockOut: "บันทึกออกงาน", requestSundayAdvance: "เลือกเบิกเงินวันอาทิตย์", saveStaff: "บันทึกพนักงาน", saveBranch: "บันทึกสาขา", saveShift: "บันทึกกะ", saveSettings: "บันทึกกฎ", saveTelegram: "ตั้งค่า Telegram", bulkUpsertTimesheets: "เพิ่มเวลาย้อนหลัง", saveLeave: "บันทึกวันลา", saveAdvance: "บันทึกเงินเบิก", approveOT: "ตรวจ OT", savePayrollDraft: "บันทึกร่างเงินเดือน", updateTimesheet: "แก้ไขเวลา", finalizePayrollPerson: "ยืนยันจ่ายเงินเดือน", reopenPayrollPerson: "ยกเลิกการยืนยันจ่าย", deleteAdminRecord: "ลบข้อมูล", importData: "นำเข้าข้อมูล"};
async function writeAudit(user, action, body, result) {
  try {
    const auditId = id("AUD"), target = text(result?.record_id || result?.staff_id || result?.advance_id || result?.leave_id || result?.run_id || result?.shift_id || result?.branch_id || result?.id || body.staff_id || body.record_id || body.id), detailParts = [];
    if (body.month) detailParts.push(`เดือน ${text(body.month)}`);
    if (body.date_from) detailParts.push(`${text(body.date_from)} ถึง ${text(body.date_to || body.date_from)}`);
    if (body.amount !== undefined) detailParts.push(`จำนวน ${number(body.amount).toLocaleString("th-TH")} บาท`);
    if (body.status) detailParts.push(`สถานะ ${text(body.status)}`);
    if (body.collection) detailParts.push(`ตาราง ${text(body.collection)}`);
    await db.collection("audit_logs").doc(auditId).set({audit_id: auditId, action, action_label: ACTION_LABELS[action] || action, actor_id: user?.staff_id || "system", actor_name: user?.nickname || user?.name || "ระบบ", target_id: target, detail: detailParts.join(" · "), created_at: nowText()});
  } catch (error) { console.error("Audit:", error); }
}
async function session(token) {
  if (!token) return null;
  const ref = db.collection("sessions").doc(sha256(token));
  const snap = await ref.get();
  if (!snap.exists || number(snap.data().expires) < Date.now()) { if (snap.exists) await ref.delete(); return null; }
  return snap.data();
}
function safeStaff(row) {
  const copy = {...row};
  delete copy.pin;
  delete copy.pin_hash;
  delete copy.pin_lookup;
  delete copy._doc_id;
  return copy;
}
async function login(pin) {
  if (!/^\d{4}$/.test(String(pin || ""))) throw Error("PIN ไม่ถูกต้อง");
  const snap = await db.collection("staff").where("pin_lookup", "==", pinLookup(pin)).limit(1).get();
  if (snap.empty) throw Error("PIN ไม่ถูกต้อง");
  const staff = snap.docs[0].data();
  if (staff.status !== "active" || !checkPin(pin, staff.pin_hash)) throw Error("PIN ไม่ถูกต้อง");
  const branch = staff.branch_id ? await getById("branches", staff.branch_id) : null;
  const token = crypto.randomBytes(32).toString("base64url"), expires = Date.now() + SESSION_MS;
  const user = {...safeStaff(staff), branch_name: branch?.name || "", expires};
  await db.collection("sessions").doc(sha256(token)).set({...user, expires, created_at: Date.now()});
  return {...user, token};
}

async function shiftById(shiftId) {
  let shift = shiftId ? await getById("shifts", shiftId) : null;
  if (!shift) shift = (await list("shifts")).find((row) => row.status === "active");
  if (!shift) throw Error("ยังไม่ได้ตั้งค่ากะงาน");
  return {...shift, start_time: timeText(shift.start_time), end_time: timeText(shift.end_time)};
}
const shiftForTimesheet = async (row) => row.shift_start && row.shift_end ? {shift_id: row.shift_id || "", name: row.shift_name || "กะเดิม", start_time: timeText(row.shift_start), end_time: timeText(row.shift_end), late_grace_min: number(row.late_grace_min), ot_grace_min: number(row.ot_grace_min)} : shiftById(row.shift_id);
async function nearestBranch(lat, lng) {
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) throw Error("ไม่พบข้อมูล GPS");
  let best = null, distance = Infinity;
  for (const branch of (await list("branches")).filter((row) => row.status === "active" && row.lat !== "" && row.lng !== "")) {
    const current = haversine(Number(lat), Number(lng), number(branch.lat), number(branch.lng));
    if (current <= number(branch.allowed_radius_m, 200) && current < distance) { best = branch; distance = current; }
  }
  if (!best) throw Error("อยู่นอกพื้นที่สาขา ไม่สามารถบันทึกเวลาได้");
  return best;
}

async function telegram(textValue) {
  try {
    const cfg = await getById("private_settings", "telegram");
    const chat = (await settings()).telegram_chat_id;
    if (!cfg?.bot_token_encrypted || !chat) return false;
    const response = await fetch(`https://api.telegram.org/bot${decrypt(cfg.bot_token_encrypted)}/sendMessage`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({chat_id: chat, text: textValue})});
    const body = await response.json();
    return Boolean(body.ok);
  } catch (error) { console.error("Telegram:", error); return false; }
}
async function testTelegram(token, chat) {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({chat_id: chat, text: "🔔 เชื่อมต่อการแจ้งเตือน Easy - Bubble เรียบร้อย"})});
  try { return Boolean((await response.json()).ok); } catch (_) { return false; }
}

async function clockIn(user, body) {
  const date = today(), existing = await timesheetForDate(user.staff_id, date);
  if (existing?.clock_in) throw Error("วันนี้บันทึกเข้างานแล้ว");
  const staff = await getById("staff", user.staff_id), branch = await nearestBranch(body.lat, body.lng), shift = await shiftById(staff.shift_id), clock = nowTime(), late = lateMinutes(clock, shift.start_time);
  const record = {record_id: id("TS"), staff_id: user.staff_id, staff_name: staff.nickname || staff.name, branch_id: branch.branch_id, branch_name: branch.name, date, clock_in: clock, clock_out: "", hours_worked: "", late_min: late, ot_hours: 0, ot_status: "none", note: "", clock_in_lat: number(body.lat), clock_in_lng: number(body.lng), clock_out_lat: "", clock_out_lng: "", created_at: nowText(), shift_id: shift.shift_id, shift_name: shift.name, shift_start: shift.start_time, shift_end: shift.end_time, late_grace_min: number(shift.late_grace_min), ot_grace_min: number(shift.ot_grace_min)};
  await db.collection("timesheets").doc(record.record_id).set(record);
  await telegram(`✅ ${record.staff_name} เข้างาน ${clock}\n🕒 ${shift.name} (${shift.start_time}–${shift.end_time})\n📍 ${branch.name}${late > number(shift.late_grace_min) ? `\n⚠️ สาย ${late} นาที` : ""}`);
  const offerRef = db.collection("advance_offers").doc(`${date}_${user.staff_id}`), offer = await offerRef.get();
  return {...record, offer_advance: user.role !== "admin" && bangkokWeekday() === "Sun" && !offer.exists};
}
async function clockOut(user, body) {
  const todayRow = await timesheetForDate(user.staff_id, today()), yesterdayRow = todayRow?.clock_out === "" ? null : await timesheetForDate(user.staff_id, yesterday());
  const row = [todayRow, yesterdayRow].find((item) => item?.clock_in && !item.clock_out);
  if (!row) throw Error("ไม่พบรายการเข้างานที่ยังไม่ได้ออก");
  const branch = await nearestBranch(body.lat, body.lng), clock = nowTime(), shift = await shiftForTimesheet(row), worked = hours(row.clock_in, clock), otMinutes = overtimeMinutes(row.clock_in, shift.end_time, clock), otHours = otMinutes > number(shift.ot_grace_min) ? round(otMinutes / 60) : 0;
  await db.collection("timesheets").doc(row.record_id).update({clock_out: clock, hours_worked: worked, ot_hours: otHours, ot_status: otHours ? "pending" : "none", clock_out_lat: number(body.lat), clock_out_lng: number(body.lng), updated_at: nowText()});
  await telegram(`🚪 ${user.nickname || user.name} ออกงาน ${clock}\n📍 ${branch.name}${otHours ? `\n⏰ OT รอตรวจ ${otHours} ชม.` : ""}`);
  return {clock_out: clock, hours_worked: worked, ot_hours: otHours};
}
async function myDashboard(user) {
  const [staff, branches, rows] = await Promise.all([getById("staff", user.staff_id), list("branches"), latestTimesheets(user.staff_id, 3)]), branch = branches.find((row) => row.branch_id === staff.branch_id);
  const todayRow = rows.find((row) => row.date === today()) || null, offer = await db.collection("advance_offers").doc(`${today()}_${user.staff_id}`).get();
  return {today: todayRow, history: rows, offer_advance: user.role !== "admin" && bangkokWeekday() === "Sun" && Boolean(todayRow?.clock_in) && !offer.exists, shift: await shiftById(staff.shift_id), profile: {staff_id: staff.staff_id, name: staff.name || "", nickname: staff.nickname || "", branch_id: staff.branch_id, branch_name: branch?.name || ""}, branches: branches.filter((row) => row.status === "active" && row.lat !== "" && row.lng !== "").map((row) => ({branch_id: row.branch_id, name: row.name, lat: number(row.lat), lng: number(row.lng), allowed_radius_m: number(row.allowed_radius_m, 200)}))};
}

async function requestSundayAdvance(user, body) {
  if (user.role === "admin") throw Error("รายการนี้สำหรับพนักงาน");
  const amount = number(body.amount);
  if (![0, 500, 1000].includes(amount)) throw Error("เลือกยอดเบิก 500 หรือ 1,000 บาท");
  if (bangkokWeekday() !== "Sun") throw Error("เบิกผ่านหน้านี้ได้เฉพาะวันอาทิตย์");
  const date = today(), timesheet = await timesheetForDate(user.staff_id, date);
  if (!timesheet?.clock_in) throw Error("กรุณาบันทึกเข้างานก่อนเลือกเบิกเงิน");
  const offerRef = db.collection("advance_offers").doc(`${date}_${user.staff_id}`), advanceRef = db.collection("advances").doc(`ADV_${date}_${user.staff_id}`), staff = await getById("staff", user.staff_id);
  const result = await db.runTransaction(async (transaction) => {
    const [offerSnap, advanceSnap] = await Promise.all([transaction.get(offerRef), transaction.get(advanceRef)]);
    if (offerSnap.exists) return {...offerSnap.data(), created: false};
    const decision = amount ? "requested" : "declined", row = {offer_id: `${date}_${user.staff_id}`, staff_id: user.staff_id, staff_name: staff?.nickname || staff?.name || user.nickname || user.name, date, decision, amount, created_at: nowText()};
    transaction.set(offerRef, row);
    if (amount && !advanceSnap.exists) transaction.set(advanceRef, {advance_id: advanceRef.id, staff_id: user.staff_id, amount, date, note: "พนักงานขอเบิกหลังเข้างานวันอาทิตย์", status: "pending", deducted_month: "", source: "sunday_prompt", created_at: nowText()});
    return {...row, created: true};
  });
  if (result.created && result.decision === "requested") await telegram(`💵 ${result.staff_name} ขอเบิกเงิน ${result.amount.toLocaleString("th-TH")} บาท\n📅 วันอาทิตย์ที่ ${date}`);
  return result;
}

async function adminData() {
  const [staff, branches, shifts, timesheets, deposits, config] = await Promise.all([list("staff"), list("branches"), list("shifts"), list("timesheets"), list("security_deposit_ledger"), settings()]);
  const visible = staff.map((row) => ({...safeStaff(row), security_deposit_balance: round(number(row.security_deposit_opening_balance) + deposits.filter((entry) => entry.staff_id === row.staff_id).reduce((sum, entry) => sum + number(entry.amount), 0)), branch_name: branches.find((b) => b.branch_id === row.branch_id)?.name || "", shift_name: shifts.find((s) => s.shift_id === row.shift_id)?.name || ""}));
  const pending = timesheets.filter((row) => row.ot_status === "pending"), date = today();
  return {staff: visible, branches, shifts, settings: config, overview: {active_staff: staff.filter((row) => row.status === "active" && row.role !== "admin").length, present_today: timesheets.filter((row) => row.date === date && row.clock_in).length, pending_ot: pending.length, today: timesheets.filter((row) => row.date === date), ot_items: pending}};
}
async function saveStaff(body) {
  const existing = body.staff_id ? await getById("staff", body.staff_id) : null;
  if (!existing && !/^\d{4}$/.test(String(body.pin || ""))) throw Error("PIN ต้องเป็นตัวเลข 4 หลัก");
  if (body.pin && !/^\d{4}$/.test(String(body.pin))) throw Error("PIN ต้องเป็นตัวเลข 4 หลัก");
  const shift = await getById("shifts", body.shift_id); if (!shift) throw Error("กรุณาเลือกกะประจำ");
  const staffId = existing?.staff_id || id("STF"), data = {staff_id: staffId, name: text(body.name), nickname: text(body.nickname), role: body.role || "staff", branch_id: text(body.branch_id), daily_rate: Math.max(0, number(body.daily_rate)), ot_rate: Math.max(0, number(body.ot_rate)), security_deposit_opening_balance: Math.max(0, number(body.security_deposit_opening_balance, number(existing?.security_deposit_opening_balance))), status: body.status || "active", shift_id: body.shift_id, bank_name: text(body.bank_name), bank_account: text(body.bank_account).replace(/\s+/g, ""), created_at: existing?.created_at || nowText(), updated_at: nowText()};
  if (body.pin) {
    const duplicate = await db.collection("staff").where("pin_lookup", "==", pinLookup(body.pin)).limit(1).get();
    if (!duplicate.empty && duplicate.docs[0].id !== staffId) throw Error("PIN นี้มีคนใช้อยู่แล้ว");
    data.pin_lookup = pinLookup(body.pin); data.pin_hash = pinHash(body.pin);
  } else { data.pin_lookup = existing.pin_lookup; data.pin_hash = existing.pin_hash; }
  await db.collection("staff").doc(staffId).set(data);
  return {staff_id: staffId};
}
async function saveShift(body) {
  if (!text(body.name)) throw Error("กรุณาตั้งชื่อกะ");
  if (!validTime(body.start_time) || !validTime(body.end_time)) throw Error("กรุณากรอกเวลาแบบ 24 ชั่วโมง เช่น 09:00");
  const shiftId = body.shift_id || id("SH"), existing = body.shift_id ? await getById("shifts", body.shift_id) : null;
  await db.collection("shifts").doc(shiftId).set({shift_id: shiftId, name: text(body.name), start_time: timeText(body.start_time), end_time: timeText(body.end_time), late_grace_min: Math.max(0, number(body.late_grace_min)), ot_grace_min: Math.max(0, number(body.ot_grace_min)), status: body.status || "active", created_at: existing?.created_at || nowText(), updated_at: nowText()});
  return {shift_id: shiftId};
}
async function saveBranch(body) {
  if (!Number.isFinite(Number(body.lat)) || !Number.isFinite(Number(body.lng))) throw Error("กรุณาบันทึกพิกัดสาขา");
  const branchId = body.branch_id || id("BR"), existing = body.branch_id ? await getById("branches", body.branch_id) : null;
  await db.collection("branches").doc(branchId).set({branch_id: branchId, name: text(body.name), lat: number(body.lat), lng: number(body.lng), allowed_radius_m: Math.max(1, number(body.allowed_radius_m, 200)), status: body.status || existing?.status || "active", created_at: existing?.created_at || nowText(), updated_at: nowText()});
  return {branch_id: branchId};
}
async function saveTelegram(body) {
  const chat = text(body.chat_id), previous = await getById("private_settings", "telegram"), token = text(body.bot_token) || (previous?.bot_token_encrypted ? decrypt(previous.bot_token_encrypted) : "");
  if (!token) throw Error("กรุณากรอก Bot Token"); if (!chat) throw Error("กรุณากรอก Chat ID");
  if (!await testTelegram(token, chat)) throw Error("เชื่อมต่อ Telegram ไม่สำเร็จ กรุณาตรวจสอบ Bot Token และ Chat ID");
  await db.collection("private_settings").doc("telegram").set({bot_token_encrypted: encrypt(token), updated_at: nowText()});
  await saveSetting("telegram_chat_id", chat, "Telegram Chat ID"); return true;
}
async function bulkUpsert(body) {
  if (!body.staff_id || !body.date_from || !body.date_to || !body.clock_in || !body.clock_out || !text(body.admin_note)) throw Error("กรุณากรอกข้อมูลให้ครบ");
  if (!validTime(body.clock_in) || !validTime(body.clock_out)) throw Error("กรุณากรอกเวลาแบบ 24 ชั่วโมง เช่น 09:00");
  const staff = await getById("staff", body.staff_id); if (!staff) throw Error("ไม่พบพนักงาน");
  const shift = await shiftById(body.shift_id || staff.shift_id), branch = await getById("branches", staff.branch_id), rows = await list("timesheets"), skip = body.skip_dates || []; let created = 0, skipped = 0;
  for (const date of dateRange(body.date_from, body.date_to)) {
    if (skip.includes(date) || rows.some((row) => row.staff_id === staff.staff_id && row.date === date)) { skipped++; continue; }
    const clockIn = timeText(body.clock_in), clockOut = timeText(body.clock_out), otMinutes = overtimeMinutes(clockIn, shift.end_time, clockOut), otHours = otMinutes > number(shift.ot_grace_min) ? round(otMinutes / 60) : 0, recordId = id("TS");
    await db.collection("timesheets").doc(recordId).set({record_id: recordId, staff_id: staff.staff_id, staff_name: staff.nickname || staff.name, branch_id: staff.branch_id, branch_name: branch?.name || "", date, clock_in: clockIn, clock_out: clockOut, hours_worked: hours(clockIn, clockOut), late_min: lateMinutes(clockIn, shift.start_time), ot_hours: otHours, ot_status: otHours ? "pending" : "none", note: `เพิ่มย้อนหลังโดยแอดมิน: ${text(body.admin_note)}`, created_at: nowText(), shift_id: shift.shift_id, shift_name: shift.name, shift_start: shift.start_time, shift_end: shift.end_time, late_grace_min: number(shift.late_grace_min), ot_grace_min: number(shift.ot_grace_min)}); created++;
  }
  return {created, skipped};
}
async function saveLeave(body) { if (!body.staff_id || !body.date_from || !body.date_to) throw Error("กรุณากรอกข้อมูลให้ครบ"); dateRange(body.date_from, body.date_to); const leaveId = id("LV"); await db.collection("leaves").doc(leaveId).set({leave_id: leaveId, staff_id: body.staff_id, date_from: body.date_from, date_to: body.date_to, leave_type: body.leave_type || "personal", note: text(body.note), status: "approved", created_at: nowText()}); return {leave_id: leaveId}; }
async function saveAdvance(body) { if (!body.staff_id || number(body.amount) <= 0) throw Error("กรุณากรอกจำนวนเงิน"); const advanceId = id("ADV"); await db.collection("advances").doc(advanceId).set({advance_id: advanceId, staff_id: body.staff_id, amount: number(body.amount), date: today(), note: text(body.note), status: "pending", deducted_month: "", created_at: nowText()}); return {advance_id: advanceId}; }
async function approveOT(body) { if (!["approved", "rejected"].includes(body.status)) throw Error("สถานะไม่ถูกต้อง"); const row = await getById("timesheets", body.record_id); if (!row) throw Error("ไม่พบรายการ"); await db.collection("timesheets").doc(body.record_id).update({ot_status: body.status, updated_at: nowText()}); return true; }

async function countPaidLeaveDays(staffId, month) {
  const dates = new Set();
  (await list("leaves")).filter((row) => row.staff_id === staffId && row.status === "approved" && row.leave_type !== "unpaid").forEach((row) => dateRange(row.date_from, row.date_to).filter((date) => date.startsWith(month)).forEach((date) => dates.add(date)));
  return dates.size;
}
function legacyAdjustments(row = {}) {
  row = row || {};
  if (Array.isArray(row.adjustments)) return row.adjustments;
  const result = [], note = text(row.adjustment_note) || "ปรับยอดเงินเดือน";
  if (number(row.extra_pay) > 0) result.push({adjustment_id: id("ADJ"), type: "add", label: note, amount: round(row.extra_pay)});
  if (number(row.other_deduct) > 0) result.push({adjustment_id: id("ADJ"), type: "deduct", label: note, amount: round(row.other_deduct)});
  return result;
}
async function payrollItem(staff, month, adjustmentRows = []) {
  if (!staff) throw Error("ไม่พบพนักงาน");
  const adjustments = sanitizeAdjustments(adjustmentRows), [config, allTimes, advances, depositBalance] = await Promise.all([settings(), list("timesheets"), list("advances"), securityDepositBalance(staff)]), times = allTimes.filter((row) => row.staff_id === staff.staff_id && String(row.date).startsWith(month)), days = new Set(times.filter((row) => row.clock_in).map((row) => row.date)).size, paidLeave = await countPaidLeaveDays(staff.staff_id, month), rate = number(staff.daily_rate), otHours = times.filter((row) => row.ot_status === "approved").reduce((sum, row) => sum + number(row.ot_hours), 0); let lateDeduct = 0;
  if (config.late_deduct_mode !== "none") for (const row of times) { const shift = await shiftForTimesheet(row), late = Math.max(0, number(row.late_min) - number(shift.late_grace_min)), shiftMinutes = Math.max(1, minutesOvernight(shift.start_time, shift.end_time)); lateDeduct += rate / shiftMinutes * late; }
  const advance = advances.filter((row) => row.staff_id === staff.staff_id && row.status === "pending").reduce((sum, row) => sum + number(row.amount), 0), base = rate * (days + paidLeave), ot = otHours * number(staff.ot_rate), extra = adjustments.filter((row) => row.type === "add").reduce((sum, row) => sum + row.amount, 0), deduct = adjustments.filter((row) => row.type === "deduct").reduce((sum, row) => sum + row.amount, 0), deposit = adjustments.filter((row) => row.type === "security_deposit").reduce((sum, row) => sum + row.amount, 0);
  return {staff_id: staff.staff_id, staff_name: staff.nickname || staff.name, bank_name: staff.bank_name || "", bank_account: staff.bank_account || "", days_worked: days, paid_leave_days: paidLeave, base_pay: round(base), ot_pay: round(ot), late_deduct: round(lateDeduct), advance_deduct: round(advance), adjustments, extra_pay: round(extra), other_deduct: round(deduct), security_deposit_deduct: round(deposit), security_deposit_balance: depositBalance, manual_adjust: round(extra - deduct - deposit), total_pay: round(base + ot - lateDeduct - advance + extra - deduct - deposit)};
}
const paidPayrollItem = (item, paid) => { const out = {...item, ...paid, adjustments: legacyAdjustments(paid), bank_name: item.bank_name, bank_account: item.bank_account, security_deposit_balance: number(paid.security_deposit_balance_after, item.security_deposit_balance), paid: true}; ["days_worked", "paid_leave_days", "base_pay", "ot_pay", "late_deduct", "advance_deduct", "extra_pay", "other_deduct", "security_deposit_deduct", "security_deposit_balance", "manual_adjust", "total_pay"].forEach((key) => { out[key] = number(out[key]); }); return out; };
async function savePayrollDraft(body) {
  if (!/^\d{4}-\d{2}$/.test(body.month || "")) throw Error("กรุณาเลือกเดือน");
  if ((await list("payroll_runs")).some((row) => row.month === body.month && row.staff_id === body.staff_id && row.status === "paid")) throw Error("พนักงานคนนี้ยืนยันจ่ายแล้ว");
  const staff = await getById("staff", body.staff_id); if (!staff) throw Error("ไม่พบพนักงาน");
  const adjustments = sanitizeAdjustments(body.adjustments || []), draftId = payrollDocId(body.month, body.staff_id), data = {draft_id: draftId, month: body.month, staff_id: body.staff_id, adjustments, status: "draft", updated_at: nowText()};
  await db.collection("payroll_drafts").doc(draftId).set(data, {merge: true});
  return payrollItem(staff, body.month, adjustments);
}
async function payrollPreview(month) {
  if (!/^\d{4}-\d{2}$/.test(month || "")) throw Error("กรุณาเลือกเดือน");
  const [runs, drafts, staff] = await Promise.all([list("payroll_runs"), list("payroll_drafts"), list("staff")]), paid = runs.filter((row) => row.month === month && row.status === "paid"), result = [];
  for (const person of staff.filter((row) => row.status === "active" && row.role !== "admin")) { const run = paid.find((row) => row.staff_id === person.staff_id), draft = drafts.find((row) => row.month === month && row.staff_id === person.staff_id), adjustments = run ? legacyAdjustments(run) : legacyAdjustments(draft), item = await payrollItem(person, month, adjustments); result.push(run ? paidPayrollItem(item, run) : {...item, paid: false, paid_at: ""}); }
  return result;
}
async function payrollDetail(body) {
  if (!/^\d{4}-\d{2}$/.test(body.month || "")) throw Error("กรุณาเลือกเดือน"); const staff = await getById("staff", body.staff_id); if (!staff) throw Error("ไม่พบพนักงาน");
  const [runs, drafts, rows, deposits] = await Promise.all([list("payroll_runs"), list("payroll_drafts"), list("timesheets"), list("security_deposit_ledger")]), paid = runs.find((row) => row.month === body.month && row.staff_id === body.staff_id && row.status === "paid"), draft = drafts.find((row) => row.month === body.month && row.staff_id === body.staff_id), adjustments = paid ? legacyAdjustments(paid) : legacyAdjustments(draft), item = await payrollItem(staff, body.month, adjustments), timesheets = rows.filter((row) => row.staff_id === body.staff_id && String(row.date).startsWith(body.month)).sort((a, b) => String(a.date).localeCompare(String(b.date))), depositHistory = deposits.filter((row) => row.staff_id === body.staff_id).sort((a, b) => String(b.month).localeCompare(String(a.month)));
  return {item: paid ? paidPayrollItem(item, paid) : {...item, paid: false, paid_at: ""}, timesheets, deposit_history: depositHistory};
}
async function updateTimesheet(body) {
  const row = await getById("timesheets", body.record_id); if (!row) throw Error("ไม่พบรายการเวลา");
  if ((await list("payroll_runs")).some((run) => run.month === String(row.date).slice(0, 7) && run.staff_id === row.staff_id && run.status === "paid")) throw Error("จ่ายเงินเดือนรอบนี้แล้ว จึงแก้เวลาไม่ได้");
  if (!validTime(body.clock_in) || !validTime(body.clock_out)) throw Error("กรุณากรอกเวลาแบบ 24 ชั่วโมง เช่น 09:00");
  const clockIn = timeText(body.clock_in), clockOut = timeText(body.clock_out), shift = await shiftForTimesheet(row), otMinutes = overtimeMinutes(clockIn, shift.end_time, clockOut), otHours = otMinutes > number(shift.ot_grace_min) ? round(otMinutes / 60) : 0; let status = otHours ? body.ot_status || "pending" : "none"; if (!["pending", "approved", "rejected", "none"].includes(status)) status = "pending";
  await db.collection("timesheets").doc(row.record_id).update({clock_in: clockIn, clock_out: clockOut, hours_worked: hours(clockIn, clockOut), late_min: lateMinutes(clockIn, shift.start_time), ot_hours: otHours, ot_status: status, note: text(body.note || row.note), updated_at: nowText()}); return true;
}
async function finalizePayrollPerson(body) {
  if (!/^\d{4}-\d{2}$/.test(body.month || "")) throw Error("กรุณาเลือกเดือน");
  if ((await list("payroll_runs")).some((row) => row.month === body.month && row.staff_id === body.staff_id && row.status === "paid")) throw Error("พนักงานคนนี้ยืนยันจ่ายแล้ว");
  const staff = await getById("staff", body.staff_id); if (!staff) throw Error("ไม่พบพนักงาน");
  const draftId = payrollDocId(body.month, body.staff_id), draft = await getById("payroll_drafts", draftId), adjustments = sanitizeAdjustments(body.adjustments ?? draft?.adjustments ?? []), item = await payrollItem(staff, body.month, adjustments), runId = `PR_${draftId}`, runRef = db.collection("payroll_runs").doc(runId), depositRef = db.collection("security_deposit_ledger").doc(`DEP_${draftId}`), draftRef = db.collection("payroll_drafts").doc(draftId), pendingAdvances = (await list("advances")).filter((row) => row.staff_id === body.staff_id && row.status === "pending"), paidAt = nowText();
  await db.runTransaction(async (transaction) => {
    const refs = [runRef, depositRef, ...pendingAdvances.map((row) => db.collection("advances").doc(row.advance_id))], snapshots = await Promise.all(refs.map((ref) => transaction.get(ref)));
    if (snapshots[0].exists) throw Error("พนักงานคนนี้ยืนยันจ่ายแล้ว");
    const runData = {run_id: runId, month: body.month, ...item, security_deposit_balance_after: round(item.security_deposit_balance + item.security_deposit_deduct), status: "paid", paid_at: paidAt};
    transaction.set(runRef, runData);
    if (item.security_deposit_deduct > 0 && !snapshots[1].exists) transaction.set(depositRef, {deposit_id: depositRef.id, staff_id: body.staff_id, staff_name: item.staff_name, month: body.month, amount: item.security_deposit_deduct, source: "payroll", payroll_run_id: runId, created_at: paidAt});
    pendingAdvances.forEach((advance, index) => { if (snapshots[index + 2].exists && snapshots[index + 2].data().status === "pending") transaction.update(refs[index + 2], {status: "deducted", deducted_month: body.month}); });
    transaction.set(draftRef, {draft_id: draftId, month: body.month, staff_id: body.staff_id, adjustments, status: "paid", updated_at: paidAt}, {merge: true});
  });
  await telegram(`💰 ยืนยันจ่ายเงินเดือน ${item.staff_name}\nรอบ ${body.month}\nยอดสุทธิ ฿${item.total_pay.toLocaleString("th-TH")}${item.security_deposit_deduct ? `\n🔒 เงินประกันเพิ่ม ฿${item.security_deposit_deduct.toLocaleString("th-TH")}` : ""}`); return {...item, security_deposit_balance: round(item.security_deposit_balance + item.security_deposit_deduct), paid: true, paid_at: paidAt};
}

const DATA_COLLECTIONS = ["timesheets", "leaves", "advances", "payroll_runs", "security_deposit_ledger", "audit_logs"];
const DATA_ID_FIELDS = {timesheets: "record_id", leaves: "leave_id", advances: "advance_id", payroll_runs: "run_id", security_deposit_ledger: "deposit_id", audit_logs: "audit_id"};
async function adminDataBrowser(body) {
  const category = DATA_COLLECTIONS.includes(body.category) ? body.category : "timesheets", collections = await Promise.all(DATA_COLLECTIONS.map((name) => list(name))), grouped = Object.fromEntries(DATA_COLLECTIONS.map((name, index) => [name, collections[index]])), rows = grouped[category].map((row) => {
    const copy = {...row, doc_id: row._doc_id, data_id: row[DATA_ID_FIELDS[category]] || row._doc_id}; delete copy._doc_id;
    if (category === "payroll_runs") delete copy.bank_account;
    return copy;
  });
  rows.sort((a, b) => String(b.date || b.month || b.created_at || "").localeCompare(String(a.date || a.month || a.created_at || "")));
  return {category, counts: Object.fromEntries(DATA_COLLECTIONS.map((name) => [name, grouped[name].length])), rows: rows.slice(0, 1000)};
}
async function reopenPayrollPerson(body) {
  if (!/^\d{4}-\d{2}$/.test(body.month || "")) throw Error("กรุณาเลือกเดือน");
  const [runs, deposits, advances, staff] = await Promise.all([list("payroll_runs"), list("security_deposit_ledger"), list("advances"), getById("staff", body.staff_id)]), matchedRuns = runs.filter((row) => row.month === body.month && row.staff_id === body.staff_id && row.status === "paid");
  if (!matchedRuns.length) throw Error("ไม่พบเงินเดือนที่ยืนยันจ่ายแล้ว");
  const matchedDeposits = deposits.filter((row) => row.month === body.month && row.staff_id === body.staff_id && row.source === "payroll"), matchedAdvances = advances.filter((row) => row.staff_id === body.staff_id && row.status === "deducted" && row.deducted_month === body.month), draftId = payrollDocId(body.month, body.staff_id), draftRef = db.collection("payroll_drafts").doc(draftId), refs = [...matchedRuns.map((row) => db.collection("payroll_runs").doc(row._doc_id)), ...matchedDeposits.map((row) => db.collection("security_deposit_ledger").doc(row._doc_id)), ...matchedAdvances.map((row) => db.collection("advances").doc(row._doc_id))], adjustments = legacyAdjustments(matchedRuns[0]);
  await db.runTransaction(async (transaction) => {
    const snapshots = await Promise.all(refs.map((ref) => transaction.get(ref))); let offset = 0;
    matchedRuns.forEach((_, index) => { if (snapshots[offset + index].exists) transaction.delete(refs[offset + index]); }); offset += matchedRuns.length;
    matchedDeposits.forEach((_, index) => { if (snapshots[offset + index].exists) transaction.delete(refs[offset + index]); }); offset += matchedDeposits.length;
    matchedAdvances.forEach((_, index) => { if (snapshots[offset + index].exists) transaction.update(refs[offset + index], {status: "pending", deducted_month: ""}); });
    transaction.set(draftRef, {draft_id: draftId, month: body.month, staff_id: body.staff_id, adjustments, status: "draft", updated_at: nowText()}, {merge: true});
  });
  const removedDeposit = round(matchedDeposits.reduce((sum, row) => sum + number(row.amount), 0));
  await telegram(`↩️ ยกเลิกการยืนยันจ่าย ${staff?.nickname || staff?.name || body.staff_id}\nรอบ ${body.month}${removedDeposit ? `\n🔓 คืนยอดเงินประกัน ฿${removedDeposit.toLocaleString("th-TH")}` : ""}`);
  return {staff_id: body.staff_id, staff_name: staff?.nickname || staff?.name || "", month: body.month, restored_advances: matchedAdvances.length, removed_deposit: removedDeposit};
}
async function deleteAdminRecord(body) {
  const collection = text(body.collection), docId = text(body.doc_id);
  if (!["timesheets", "leaves", "advances"].includes(collection) || !docId) throw Error("รายการนี้ไม่อนุญาตให้ลบโดยตรง");
  const row = await getById(collection, docId); if (!row) throw Error("ไม่พบข้อมูลที่ต้องการลบ");
  const runs = await list("payroll_runs");
  if (collection === "timesheets" && runs.some((run) => run.staff_id === row.staff_id && run.month === String(row.date).slice(0, 7) && run.status === "paid")) throw Error("เดือนนี้ยืนยันจ่ายแล้ว กรุณายกเลิกการยืนยันจ่ายก่อน");
  if (collection === "leaves") { const months = new Set(dateRange(row.date_from, row.date_to).map((date) => date.slice(0, 7))); if (runs.some((run) => run.staff_id === row.staff_id && months.has(run.month) && run.status === "paid")) throw Error("วันลานี้อยู่ในรอบที่จ่ายแล้ว กรุณายกเลิกการยืนยันจ่ายก่อน"); }
  if (collection === "advances" && row.status !== "pending") throw Error("เงินเบิกรายการนี้หักไปแล้ว กรุณายกเลิกการยืนยันจ่ายก่อน");
  await db.collection(collection).doc(docId).delete();
  return {id: docId, collection, staff_id: row.staff_id || ""};
}

async function bootstrap(body) {
  if (!crypto.timingSafeEqual(Buffer.from(sha256(body.bootstrap_key || "")), Buffer.from(sha256(BOOTSTRAP_KEY.value())))) throw Error("รหัสเริ่มต้นไม่ถูกต้อง");
  if (!(await list("staff")).length) {
    const pin = String(body.admin_pin || ""); if (!/^\d{4}$/.test(pin)) throw Error("กรุณาตั้ง PIN แอดมิน 4 หลัก");
    const shiftId = "SH001", branchId = "BR001", staffId = "STF001";
    await Promise.all([
      db.collection("shifts").doc(shiftId).set({shift_id: shiftId, name: "กะหลัก", start_time: "09:00", end_time: "18:00", late_grace_min: 15, ot_grace_min: 15, status: "active", created_at: nowText()}),
      db.collection("branches").doc(branchId).set({branch_id: branchId, name: "วังหิน", lat: 13.824278, lng: 100.59014, allowed_radius_m: 200, status: "active", created_at: nowText()}),
      db.collection("branches").doc("BR002").set({branch_id: "BR002", name: "สะพานใหม่", lat: 13.89151, lng: 100.605883, allowed_radius_m: 200, status: "active", created_at: nowText()}),
      db.collection("staff").doc(staffId).set({staff_id: staffId, name: "ผู้ดูแลระบบ", nickname: "แอดมิน", pin_lookup: pinLookup(pin), pin_hash: pinHash(pin), role: "admin", branch_id: branchId, daily_rate: 0, ot_rate: 0, security_deposit_opening_balance: 0, status: "active", shift_id: shiftId, bank_name: "", bank_account: "", created_at: nowText()}),
      saveSetting("shop_name", "Easy - Bubble", "ชื่อร้าน"), saveSetting("late_deduct_mode", "per_minute", "วิธีหักมาสาย"), saveSetting("telegram_chat_id", "", "Telegram Chat ID")
    ]);
  }
  return {ready: true};
}
async function importData(body) {
  const payload = body.data || {}; let imported = 0;
  for (const name of COLLECTIONS) {
    for (const original of Array.isArray(payload[name]) ? payload[name] : []) {
      const row = {...original}; let docId = row[({staff: "staff_id", branches: "branch_id", shifts: "shift_id", timesheets: "record_id", leaves: "leave_id", advances: "advance_id", payroll_runs: "run_id", payroll_drafts: "draft_id", security_deposit_ledger: "deposit_id", advance_offers: "offer_id", settings: "key", audit_logs: "audit_id"})[name]] || id(name.slice(0, 2).toUpperCase());
      if (name === "staff" && row.pin) { row.pin_lookup = pinLookup(String(row.pin)); row.pin_hash = pinHash(String(row.pin)); delete row.pin; }
      Object.keys(row).forEach((key) => { if (row[key] === undefined) delete row[key]; });
      await db.collection(name).doc(String(docId)).set(row, {merge: true}); imported++;
    }
  }
  return {imported};
}

const adminOnly = new Set(["adminData", "adminDataBrowser", "saveStaff", "saveBranch", "saveShift", "saveSettings", "saveTelegram", "bulkUpsertTimesheets", "saveLeave", "saveAdvance", "approveOT", "payrollPreview", "payrollDetail", "savePayrollDraft", "updateTimesheet", "finalizePayrollPerson", "reopenPayrollPerson", "deleteAdminRecord", "importData"]);
async function route(body) {
  if (body.action === "login") return login(body.pin);
  if (body.action === "bootstrap") return bootstrap(body);
  const user = await session(body.token); if (!user) throw Error("เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่");
  if (adminOnly.has(body.action) && user.role !== "admin") throw Error("ไม่มีสิทธิ์ทำรายการนี้");
  let result;
  switch (body.action) {
    case "myDashboard": result = await myDashboard(user); break;
    case "clockIn": result = await clockIn(user, body); break;
    case "clockOut": result = await clockOut(user, body); break;
    case "requestSundayAdvance": result = await requestSundayAdvance(user, body); break;
    case "adminData": result = await adminData(); break;
    case "adminDataBrowser": result = await adminDataBrowser(body); break;
    case "saveStaff": result = await saveStaff(body); break;
    case "saveBranch": result = await saveBranch(body); break;
    case "saveShift": result = await saveShift(body); break;
    case "saveSettings": for (const [key, value] of Object.entries(body.settings || {})) await saveSetting(key, value); result = await settings(); break;
    case "saveTelegram": result = await saveTelegram(body); break;
    case "bulkUpsertTimesheets": result = await bulkUpsert(body); break;
    case "saveLeave": result = await saveLeave(body); break;
    case "saveAdvance": result = await saveAdvance(body); break;
    case "approveOT": result = await approveOT(body); break;
    case "payrollPreview": result = await payrollPreview(body.month); break;
    case "payrollDetail": result = await payrollDetail(body); break;
    case "savePayrollDraft": result = await savePayrollDraft(body); break;
    case "updateTimesheet": result = await updateTimesheet(body); break;
    case "finalizePayrollPerson": result = await finalizePayrollPerson(body); break;
    case "reopenPayrollPerson": result = await reopenPayrollPerson(body); break;
    case "deleteAdminRecord": result = await deleteAdminRecord(body); break;
    case "importData": result = await importData(body); break;
    default: throw Error("ไม่พบคำสั่งที่ร้องขอ");
  }
  if (MUTATING_ACTIONS.has(body.action)) await writeAudit(user, body.action, body, result);
  return result;
}

exports.api = async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "content-type");
  res.set("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return res.status(405).json({success: false, message: "Method not allowed"});
  try { return res.json({success: true, data: await route(req.body || {})}); }
  catch (error) { console.error(error); return res.status(200).json({success: false, message: error.message || "เกิดข้อผิดพลาด"}); }
};
