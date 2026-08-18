# ติดตั้ง Firebase สำหรับ Easy - Bubble

ระบบใน branch นี้แยกจากเว็บจริงเดิม จึงทดลองได้โดยไม่กระทบการลงเวลาของร้าน

## สิ่งที่วิวต้องทำ

1. ไปที่ [Firebase Console](https://console.firebase.google.com/) แล้วกด **Create a project**
2. ตั้งชื่อ เช่น `easy-bubble-backoffice` และปิด Google Analytics ได้
3. Project ID ของระบบนี้คือ `easy-bubble-backoffice`
4. เปิด Billing และเลือกแผน Blaze เพื่อให้ใช้ Cloud Functions ได้ ค่าใช้จ่ายจริงยังอยู่ภายใต้โควตาฟรีตามการใช้งาน
5. ตอนสร้าง Firestore ให้เลือก location `asia-southeast1 (Singapore)` ถ้ามีตัวเลือกนี้ และห้ามสร้างคนละ location ก่อนจีนี่ตรวจ

## ขั้น deploy

ต้องใช้ Node.js 22 และ Firebase CLI:

```bash
npm install -g firebase-tools
firebase login
firebase functions:secrets:set APP_ENCRYPTION_KEY
firebase functions:secrets:set BOOTSTRAP_KEY
cd functions && npm install && cd ..
firebase deploy
```

ค่าความลับทั้งสองควรเป็นข้อความสุ่มยาวอย่างน้อย 32 ตัวอักษร ห้ามใส่ใน GitHub หรือส่งในแชต

## ย้ายข้อมูลจาก Google Sheet

1. เพิ่มไฟล์ `migration/ExportFirebase.gs` ใน Apps Script เดิม
2. รัน `exportForFirebase()` ระบบจะสร้างไฟล์ JSON ใน Google Drive
3. ดาวน์โหลดไฟล์ JSON มาไว้ในเครื่อง
4. รันตัวนำเข้าโดยใช้ PIN เริ่มต้นและ bootstrap key ที่ตั้งไว้

```bash
ADMIN_PIN=1234 BOOTSTRAP_KEY='ค่าที่ตั้งไว้' node migration/import.mjs https://easy-bubble-backoffice.web.app/api ./easy-bubble-firebase-export.json
```

หลังนำเข้า ให้เข้าสู่เว็บทดสอบด้วย PIN เดิม ตรวจพนักงาน เวลา เงินเดือน และตั้ง Telegram ใหม่จากหน้าเว็บ ก่อนสลับเว็บจริง

## การป้องกันข้อมูล

- Firestore Rules ปิดการอ่านและเขียนจาก browser ทั้งหมด
- ทุกคำสั่งผ่าน Cloud Function และตรวจ session/สิทธิ์ admin
- PIN เก็บเป็น scrypt hash ไม่ใช่ตัวเลขที่อ่านได้
- Telegram Bot Token เข้ารหัส AES-256-GCM ก่อนบันทึก
- Cloud Function จำกัดจำนวน instance เพื่อช่วยควบคุมค่าใช้จ่าย
