#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="easy-bubble-backoffice"
REGION="asia-southeast3"
SERVICE_ACCOUNT="easy-bubble-api@${PROJECT_ID}.iam.gserviceaccount.com"

if command -v firebase >/dev/null 2>&1; then
  FIREBASE=(firebase)
else
  FIREBASE=(npx --yes firebase-tools@latest)
fi

echo "[1/3] ติดตั้ง Backend เวอร์ชันล่าสุด"
npm --prefix functions ci --no-audit --no-fund

echo "[2/3] อัปเดต Backend โดยใช้กุญแจเดิม"
gcloud run deploy easy-bubble-api \
  --source functions \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --service-account "$SERVICE_ACCOUNT" \
  --set-secrets="APP_ENCRYPTION_KEY=APP_ENCRYPTION_KEY:latest,BOOTSTRAP_KEY=BOOTSTRAP_KEY:latest" \
  --memory=256Mi \
  --max-instances=5 \
  --allow-unauthenticated \
  --quiet

echo "[3/3] อัปเดตหน้าเว็บและกฎฐานข้อมูล"
DEPLOYED=false
for ATTEMPT in 1 2 3 4 5; do
  if "${FIREBASE[@]}" deploy --only firestore,hosting --project "$PROJECT_ID"; then
    DEPLOYED=true
    break
  fi
  echo "การเชื่อมต่อสะดุด รอ 5 วินาทีแล้วลองใหม่ (${ATTEMPT}/5)..."
  sleep 5
done

if [[ "$DEPLOYED" != true ]]; then
  echo "อัปโหลดหน้าเว็บไม่สำเร็จหลังลอง 5 ครั้ง กรุณาส่งข้อความผิดพลาดให้จีนี่"
  exit 1
fi

echo
echo "อัปเดตสำเร็จ: https://${PROJECT_ID}.web.app"
echo "ข้อมูลเดิม, PIN และ Telegram ไม่ถูกลบหรือเปลี่ยน"
