#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="easy-bubble-backoffice"
SITE_URL="https://${PROJECT_ID}.web.app"

if command -v firebase >/dev/null 2>&1; then
  FIREBASE=(firebase)
else
  FIREBASE=(npx --yes firebase-tools@latest)
fi

echo "[1/5] ตรวจบัญชีและ Firebase Project"
"${FIREBASE[@]}" projects:list >/dev/null

echo "[2/5] ติดตั้ง Cloud Functions"
npm --prefix functions ci --no-audit --no-fund

echo "[3/5] สร้างกุญแจความปลอดภัย"
APP_KEY_VALUE="$(openssl rand -hex 32)"
BOOTSTRAP_KEY_VALUE="$(openssl rand -hex 32)"
printf '%s' "$APP_KEY_VALUE" | "${FIREBASE[@]}" functions:secrets:set APP_ENCRYPTION_KEY --data-file=- --project "$PROJECT_ID"
printf '%s' "$BOOTSTRAP_KEY_VALUE" | "${FIREBASE[@]}" functions:secrets:set BOOTSTRAP_KEY --data-file=- --project "$PROJECT_ID"

echo "[4/5] Deploy Firestore, Functions และ Hosting"
"${FIREBASE[@]}" deploy --project "$PROJECT_ID"

while true; do
  read -r -s -p "ตั้ง PIN แอดมิน 4 หลัก (ใช้ PIN เดิมได้): " ADMIN_PIN
  echo
  if [[ "$ADMIN_PIN" =~ ^[0-9]{4}$ ]]; then break; fi
  echo "PIN ต้องเป็นตัวเลข 4 หลัก"
done

echo "[5/5] สร้างผู้ดูแลระบบเริ่มต้น"
RESPONSE="$(curl --fail --silent --show-error -X POST "${SITE_URL}/api" \
  -H 'content-type: application/json' \
  --data "{\"action\":\"bootstrap\",\"bootstrap_key\":\"${BOOTSTRAP_KEY_VALUE}\",\"admin_pin\":\"${ADMIN_PIN}\"}")"

unset APP_KEY_VALUE BOOTSTRAP_KEY_VALUE ADMIN_PIN
if [[ "$RESPONSE" != *'"success":true'* ]]; then
  echo "สร้างผู้ดูแลไม่สำเร็จ: $RESPONSE"
  exit 1
fi

echo
echo "Deploy สำเร็จ: ${SITE_URL}"
echo "ระบบนี้เป็นเว็บทดสอบ ยังไม่กระทบเว็บเดิม"
