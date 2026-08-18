#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="easy-bubble-backoffice"
SITE_URL="https://${PROJECT_ID}.web.app"

if command -v firebase >/dev/null 2>&1; then
  FIREBASE=(firebase)
else
  FIREBASE=(npx --yes firebase-tools@latest)
fi

echo "อัปโหลด Firestore Rules และหน้าเว็บต่อจากจุดที่ค้าง"
DEPLOYED=false
for ATTEMPT in 1 2 3 4 5; do
  echo "ลองอัปโหลดครั้งที่ ${ATTEMPT}/5"
  if "${FIREBASE[@]}" deploy --only firestore,hosting --project "$PROJECT_ID"; then
    DEPLOYED=true
    break
  fi
  echo "การเชื่อมต่อสะดุด รอ 5 วินาทีแล้วลองใหม่..."
  sleep 5
done
if [[ "$DEPLOYED" != true ]]; then
  echo "อัปโหลดไม่สำเร็จหลังลอง 5 ครั้ง กรุณาส่งข้อความผิดพลาดให้จีนี่"
  exit 1
fi

while true; do
  read -r -s -p "ตั้ง PIN แอดมิน 4 หลัก (ใช้ PIN เดิมได้): " ADMIN_PIN
  echo
  if [[ "$ADMIN_PIN" =~ ^[0-9]{4}$ ]]; then break; fi
  echo "PIN ต้องเป็นตัวเลข 4 หลัก"
done

BOOTSTRAP_KEY_VALUE="$(gcloud secrets versions access latest --secret=BOOTSTRAP_KEY --project "$PROJECT_ID")"
echo "สร้างผู้ดูแลระบบเริ่มต้น"
RESPONSE="$(curl --fail --silent --show-error -X POST "${SITE_URL}/api" \
  -H 'content-type: application/json' \
  --data "{\"action\":\"bootstrap\",\"bootstrap_key\":\"${BOOTSTRAP_KEY_VALUE}\",\"admin_pin\":\"${ADMIN_PIN}\"}")"
unset BOOTSTRAP_KEY_VALUE ADMIN_PIN

if [[ "$RESPONSE" != *'"success":true'* ]]; then
  echo "สร้างผู้ดูแลไม่สำเร็จ: $RESPONSE"
  exit 1
fi

echo
echo "เสร็จเรียบร้อย: ${SITE_URL}"
echo "ระบบนี้เป็นเว็บทดสอบ ยังไม่กระทบเว็บเดิม"
