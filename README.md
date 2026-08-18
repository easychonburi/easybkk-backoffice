# Easy - Bubble Backoffice · Firebase

Firebase migration ของระบบบันทึกเวลาและเงินเดือน Easy - Bubble สำหรับสาขาวังหินและสะพานใหม่

## สถานะ

branch นี้เป็นระบบทดสอบคู่ขนาน ระบบจริง Google Sheets + Apps Script ยังทำงานเหมือนเดิมจนกว่าจะตรวจข้อมูลและอนุมัติสลับระบบ

## สถาปัตยกรรม

- Firebase Hosting: หน้าเว็บเดิมและ PWA
- Cloud Functions v2 (Node.js 22): ตรวจ PIN, session, GPS, สิทธิ์ และคำนวณเงินเดือน
- Cloud Firestore: พนักงาน สาขา กะ เวลา วันลา เงินเบิก และรอบเงินเดือน
- Firestore Security Rules: ปิด direct client access ทุก collection
- Telegram Bot Token: เข้ารหัสก่อนบันทึก และไม่อยู่ใน GitHub

## ฟีเจอร์ที่ย้ายมาครบ

- PIN 4 หลักแยกพนักงาน/ผู้ดูแล และเปลี่ยน PIN จากหน้าเว็บ
- บังคับ GPS ตอนเข้า–ออกงาน รองรับหลายสาขา
- หลายกะ ตั้งชื่อ เวลา grace period และกะประจำได้
- เพิ่มเวลาย้อนหลัง วันลา เงินเบิก ตรวจ OT และหักมาสาย
- รายละเอียดเงินเดือนรายคน แก้เวลา เพิ่ม/หักเงิน ดูและคัดลอกเลขบัญชี
- ยืนยันจ่ายทีละคนและล็อกข้อมูลที่จ่ายแล้ว
- แจ้ง Telegram, loading state, mobile UI และ PWA
- วันและเวลาทั้งหมดคำนวณด้วย `Asia/Bangkok`

ดูขั้นตอนสร้างโปรเจกต์และย้ายข้อมูลที่ [FIREBASE_SETUP.md](FIREBASE_SETUP.md)
