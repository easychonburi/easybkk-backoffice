/**
 * วางไฟล์นี้เพิ่มในโปรเจกต์ Apps Script เดิม แล้วรัน exportForFirebase() หนึ่งครั้ง
 * ระบบจะสร้าง easy-bubble-firebase-export.json ใน Google Drive ของเจ้าของชีต
 * ไม่ส่งออก Telegram Bot Token เพราะต้องตั้งใหม่จากหน้าเว็บหลังย้ายเสร็จ
 */
function exportForFirebase() {
  const names = ['staff','branches','shifts','timesheets','leaves','advances','payroll_runs','settings'];
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const output = {exported_at: Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd HH:mm:ss'), source_sheet_id: ss.getId()};
  names.forEach(function(name) {
    const sheet = ss.getSheetByName(name);
    if (!sheet) { output[name] = []; return; }
    const values = sheet.getDataRange().getDisplayValues();
    if (values.length < 2) { output[name] = []; return; }
    const headers = values[0];
    output[name] = values.slice(1).filter(function(row) { return row.some(String); }).map(function(row) {
      const item = {};
      headers.forEach(function(key, index) { item[key] = row[index]; });
      return item;
    });
  });
  const file = DriveApp.createFile('easy-bubble-firebase-export.json', JSON.stringify(output), MimeType.PLAIN_TEXT);
  SpreadsheetApp.getUi().alert('ส่งออกเรียบร้อย\nไฟล์อยู่ใน Google Drive ชื่อ:\n' + file.getName());
  return file.getUrl();
}
