"use strict";

const crypto = require("node:crypto");
const {onRequest} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const {setGlobalOptions} = require("firebase-functions/v2/options");
const {initializeApp} = require("firebase-admin/app");
const {getFirestore, FieldValue} = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();
const APP_KEY = defineSecret("APP_ENCRYPTION_KEY");
const BOOTSTRAP_KEY = defineSecret("BOOTSTRAP_KEY");
const SESSION_MS = 6 * 60 * 60 * 1000;
const COLLECTIONS = ["staff", "branches", "shifts", "timesheets", "leaves", "advances", "payroll_runs", "settings"];

setGlobalOptions({region: "asia-southeast1", maxInstances: 5, memory: "256MiB", timeoutSeconds: 60});

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
async function settings() {
  const rows = await list("settings");
  return Object.fromEntries(rows.map((row) => [row.key || row._doc_id, String(row.value ?? "")]));
}
async function saveSetting(key, value, description = "") {
  await db.collection("settings").doc(String(key)).set({key: String(key), value: String(value ?? ""), description}, {merge: true});
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
  const rows = await list("timesheets"), date = today();
  if (rows.some((row) => row.staff_id === user.staff_id && row.date === date && row.clock_in)) throw Error("วันนี้บันทึกเข้างานแล้ว");
  const staff = await getById("staff", user.staff_id), branch = await nearestBranch(body.lat, body.lng), shift = await shiftById(staff.shift_id), clock = nowTime(), late = lateMinutes(clock, shift.start_time);
  const record = {record_id: id("TS"), staff_id: user.staff_id, staff_name: staff.nickname || staff.name, branch_id: branch.branch_id, branch_name: branch.name, date, clock_in: clock, clock_out: "", hours_worked: "", late_min: late, ot_hours: 0, ot_status: "none", note: "", clock_in_lat: number(body.lat), clock_in_lng: number(body.lng), clock_out_lat: "", clock_out_lng: "", created_at: nowText(), shift_id: shift.shift_id, shift_name: shift.name, shift_start: shift.start_time, shift_end: shift.end_time, late_grace_min: number(shift.late_grace_min), ot_grace_min: number(shift.ot_grace_min)};
  await db.collection("timesheets").doc(record.record_id).set(record);
  await telegram(`✅ ${record.staff_name} เข้างาน ${clock}\n🕒 ${shift.name} (${shift.start_time}–${shift.end_time})\n📍 ${branch.name}${late > number(shift.late_grace_min) ? `\n⚠️ สาย ${late} นาที` : ""}`);
  return record;
}
async function clockOut(user, body) {
  const rows = await list("timesheets");
  const row = rows.find((item) => item.staff_id === user.staff_id && !item.clock_out && (item.date === today() || item.date === yesterday()));
  if (!row) throw Error("ไม่พบรายการเข้างานที่ยังไม่ได้ออก");
  const branch = await nearestBranch(body.lat, body.lng), clock = nowTime(), shift = await shiftForTimesheet(row), worked = hours(row.clock_in, clock), otMinutes = overtimeMinutes(row.clock_in, shift.end_time, clock), otHours = otMinutes > number(shift.ot_grace_min) ? round(otMinutes / 60) : 0;
  await db.collection("timesheets").doc(row.record_id).update({clock_out: clock, hours_worked: worked, ot_hours: otHours, ot_status: otHours ? "pending" : "none", clock_out_lat: number(body.lat), clock_out_lng: number(body.lng), updated_at: nowText()});
  await telegram(`🚪 ${user.nickname || user.name} ออกงาน ${clock}\n📍 ${branch.name}${otHours ? `\n⏰ OT รอตรวจ ${otHours} ชม.` : ""}`);
  return {clock_out: clock, hours_worked: worked, ot_hours: otHours};
}
async function myDashboard(user) {
  const staff = await getById("staff", user.staff_id), branches = await list("branches"), rows = (await list("timesheets")).filter((row) => row.staff_id === user.staff_id).sort((a, b) => String(b.date).localeCompare(String(a.date))), branch = branches.find((row) => row.branch_id === staff.branch_id);
  return {today: rows.find((row) => row.date === today()) || null, history: rows.slice(0, 7), shift: await shiftById(staff.shift_id), profile: {staff_id: staff.staff_id, name: staff.name || "", nickname: staff.nickname || "", branch_id: staff.branch_id, branch_name: branch?.name || ""}, branches: branches.filter((row) => row.status === "active" && row.lat !== "" && row.lng !== "").map((row) => ({branch_id: row.branch_id, name: row.name, lat: number(row.lat), lng: number(row.lng), allowed_radius_m: number(row.allowed_radius_m, 200)}))};
}

async function adminData() {
  const [staff, branches, shifts, timesheets, config] = await Promise.all([list("staff"), list("branches"), list("shifts"), list("timesheets"), settings()]);
  const visible = staff.map((row) => ({...safeStaff(row), branch_name: branches.find((b) => b.branch_id === row.branch_id)?.name || "", shift_name: shifts.find((s) => s.shift_id === row.shift_id)?.name || ""}));
  const pending = timesheets.filter((row) => row.ot_status === "pending"), date = today();
  return {staff: visible, branches, shifts, settings: config, overview: {active_staff: staff.filter((row) => row.status === "active" && row.role !== "admin").length, present_today: timesheets.filter((row) => row.date === date && row.clock_in).length, pending_ot: pending.length, today: timesheets.filter((row) => row.date === date), ot_items: pending}};
}
async function saveStaff(body) {
  const existing = body.staff_id ? await getById("staff", body.staff_id) : null;
  if (!existing && !/^\d{4}$/.test(String(body.pin || ""))) throw Error("PIN ต้องเป็นตัวเลข 4 หลัก");
  if (body.pin && !/^\d{4}$/.test(String(body.pin))) throw Error("PIN ต้องเป็นตัวเลข 4 หลัก");
  const shift = await getById("shifts", body.shift_id); if (!shift) throw Error("กรุณาเลือกกะประจำ");
  const staffId = existing?.staff_id || id("STF"), data = {staff_id: staffId, name: text(body.name), nickname: text(body.nickname), role: body.role || "staff", branch_id: text(body.branch_id), daily_rate: Math.max(0, number(body.daily_rate)), ot_rate: Math.max(0, number(body.ot_rate)), status: body.status || "active", shift_id: body.shift_id, bank_name: text(body.bank_name), bank_account: text(body.bank_account).replace(/\s+/g, ""), created_at: existing?.created_at || nowText(), updated_at: nowText()};
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
async function payrollItem(staff, month, extraPay = 0, otherDeduct = 0, note = "") {
  if (!staff) throw Error("ไม่พบพนักงาน");
  const [config, allTimes, advances] = await Promise.all([settings(), list("timesheets"), list("advances")]), times = allTimes.filter((row) => row.staff_id === staff.staff_id && String(row.date).startsWith(month)), days = new Set(times.filter((row) => row.clock_in).map((row) => row.date)).size, paidLeave = await countPaidLeaveDays(staff.staff_id, month), rate = number(staff.daily_rate), otHours = times.filter((row) => row.ot_status === "approved").reduce((sum, row) => sum + number(row.ot_hours), 0); let lateDeduct = 0;
  if (config.late_deduct_mode !== "none") for (const row of times) { const shift = await shiftForTimesheet(row), late = Math.max(0, number(row.late_min) - number(shift.late_grace_min)), shiftMinutes = Math.max(1, minutesOvernight(shift.start_time, shift.end_time)); lateDeduct += rate / shiftMinutes * late; }
  const advance = advances.filter((row) => row.staff_id === staff.staff_id && row.status === "pending").reduce((sum, row) => sum + number(row.amount), 0), base = rate * (days + paidLeave), ot = otHours * number(staff.ot_rate), extra = Math.max(0, number(extraPay)), deduct = Math.max(0, number(otherDeduct));
  return {staff_id: staff.staff_id, staff_name: staff.nickname || staff.name, bank_name: staff.bank_name || "", bank_account: staff.bank_account || "", days_worked: days, paid_leave_days: paidLeave, base_pay: round(base), ot_pay: round(ot), late_deduct: round(lateDeduct), advance_deduct: round(advance), extra_pay: round(extra), other_deduct: round(deduct), adjustment_note: text(note), manual_adjust: round(extra - deduct), total_pay: round(base + ot - lateDeduct - advance + extra - deduct)};
}
const paidPayrollItem = (item, paid) => { const out = {...item, ...paid, bank_name: item.bank_name, bank_account: item.bank_account, paid: true}; ["days_worked", "paid_leave_days", "base_pay", "ot_pay", "late_deduct", "advance_deduct", "extra_pay", "other_deduct", "manual_adjust", "total_pay"].forEach((key) => { out[key] = number(out[key]); }); return out; };
async function payrollPreview(month) {
  if (!/^\d{4}-\d{2}$/.test(month || "")) throw Error("กรุณาเลือกเดือน");
  const [runs, staff] = await Promise.all([list("payroll_runs"), list("staff")]), paid = runs.filter((row) => row.month === month && row.status === "paid"), result = [];
  for (const person of staff.filter((row) => row.status === "active" && row.role !== "admin")) { const run = paid.find((row) => row.staff_id === person.staff_id), item = await payrollItem(person, month, run?.extra_pay, run?.other_deduct, run?.adjustment_note); result.push(run ? paidPayrollItem(item, run) : {...item, paid: false, paid_at: ""}); }
  return result;
}
async function payrollDetail(body) {
  if (!/^\d{4}-\d{2}$/.test(body.month || "")) throw Error("กรุณาเลือกเดือน"); const staff = await getById("staff", body.staff_id); if (!staff) throw Error("ไม่พบพนักงาน");
  const [runs, rows] = await Promise.all([list("payroll_runs"), list("timesheets")]), paid = runs.find((row) => row.month === body.month && row.staff_id === body.staff_id && row.status === "paid"), item = await payrollItem(staff, body.month, paid?.extra_pay, paid?.other_deduct, paid?.adjustment_note), timesheets = rows.filter((row) => row.staff_id === body.staff_id && String(row.date).startsWith(body.month)).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return {item: paid ? paidPayrollItem(item, paid) : {...item, paid: false, paid_at: ""}, timesheets};
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
  const staff = await getById("staff", body.staff_id), item = await payrollItem(staff, body.month, body.extra_pay, body.other_deduct, body.adjustment_note), runId = id("PR");
  await db.collection("payroll_runs").doc(runId).set({run_id: runId, month: body.month, ...item, status: "paid", paid_at: nowText()});
  for (const advance of (await list("advances")).filter((row) => row.staff_id === body.staff_id && row.status === "pending")) await db.collection("advances").doc(advance.advance_id).update({status: "deducted", deducted_month: body.month});
  await telegram(`💰 ยืนยันจ่ายเงินเดือน ${item.staff_name}\nรอบ ${body.month}\nยอดสุทธิ ฿${item.total_pay.toLocaleString("th-TH")}`); return item;
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
      db.collection("staff").doc(staffId).set({staff_id: staffId, name: "ผู้ดูแลระบบ", nickname: "แอดมิน", pin_lookup: pinLookup(pin), pin_hash: pinHash(pin), role: "admin", branch_id: branchId, daily_rate: 0, ot_rate: 0, status: "active", shift_id: shiftId, bank_name: "", bank_account: "", created_at: nowText()}),
      saveSetting("shop_name", "Easy - Bubble", "ชื่อร้าน"), saveSetting("late_deduct_mode", "per_minute", "วิธีหักมาสาย"), saveSetting("telegram_chat_id", "", "Telegram Chat ID")
    ]);
  }
  return {ready: true};
}
async function importData(body) {
  const payload = body.data || {}; let imported = 0;
  for (const name of COLLECTIONS) {
    for (const original of Array.isArray(payload[name]) ? payload[name] : []) {
      const row = {...original}; let docId = row[({staff: "staff_id", branches: "branch_id", shifts: "shift_id", timesheets: "record_id", leaves: "leave_id", advances: "advance_id", payroll_runs: "run_id", settings: "key"})[name]] || id(name.slice(0, 2).toUpperCase());
      if (name === "staff" && row.pin) { row.pin_lookup = pinLookup(String(row.pin)); row.pin_hash = pinHash(String(row.pin)); delete row.pin; }
      Object.keys(row).forEach((key) => { if (row[key] === undefined) delete row[key]; });
      await db.collection(name).doc(String(docId)).set(row, {merge: true}); imported++;
    }
  }
  return {imported};
}

const adminOnly = new Set(["adminData", "saveStaff", "saveBranch", "saveShift", "saveSettings", "saveTelegram", "bulkUpsertTimesheets", "saveLeave", "saveAdvance", "approveOT", "payrollPreview", "payrollDetail", "updateTimesheet", "finalizePayrollPerson", "importData"]);
async function route(body) {
  if (body.action === "login") return login(body.pin);
  if (body.action === "bootstrap") return bootstrap(body);
  const user = await session(body.token); if (!user) throw Error("เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่");
  if (adminOnly.has(body.action) && user.role !== "admin") throw Error("ไม่มีสิทธิ์ทำรายการนี้");
  switch (body.action) {
    case "myDashboard": return myDashboard(user);
    case "clockIn": return clockIn(user, body);
    case "clockOut": return clockOut(user, body);
    case "adminData": return adminData();
    case "saveStaff": return saveStaff(body);
    case "saveBranch": return saveBranch(body);
    case "saveShift": return saveShift(body);
    case "saveSettings": for (const [key, value] of Object.entries(body.settings || {})) await saveSetting(key, value); return settings();
    case "saveTelegram": return saveTelegram(body);
    case "bulkUpsertTimesheets": return bulkUpsert(body);
    case "saveLeave": return saveLeave(body);
    case "saveAdvance": return saveAdvance(body);
    case "approveOT": return approveOT(body);
    case "payrollPreview": return payrollPreview(body.month);
    case "payrollDetail": return payrollDetail(body);
    case "updateTimesheet": return updateTimesheet(body);
    case "finalizePayrollPerson": return finalizePayrollPerson(body);
    case "importData": return importData(body);
    default: throw Error("ไม่พบคำสั่งที่ร้องขอ");
  }
}

exports.api = onRequest({secrets: [APP_KEY, BOOTSTRAP_KEY], cors: true, invoker: "public"}, async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return res.status(405).json({success: false, message: "Method not allowed"});
  try { return res.json({success: true, data: await route(req.body || {})}); }
  catch (error) { console.error(error); return res.status(200).json({success: false, message: error.message || "เกิดข้อผิดพลาด"}); }
});
