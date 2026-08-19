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

echo "[1/4] ติดตั้ง Backend เวอร์ชันล่าสุด"
npm --prefix functions ci --no-audit --no-fund

echo "[2/4] อัปเดตกฎและดัชนีฐานข้อมูลก่อน"
"${FIREBASE[@]}" deploy --only firestore --project "$PROJECT_ID"

echo "รอให้ดัชนีฐานข้อมูลพร้อมใช้งาน..."
for ATTEMPT in $(seq 1 60); do
  INDEX_STATES="$(gcloud firestore indexes composite list --database="(default)" --project "$PROJECT_ID" --format="value(state)" 2>/dev/null || true)"
  if [[ "$INDEX_STATES" != *CREATING* ]]; then
    break
  fi
  sleep 5
done

echo "[3/4] อัปเดต Backend โดยใช้กุญแจเดิม"
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

echo "[4/4] อัปเดตหน้าเว็บ"
DEPLOYED=false
for ATTEMPT in 1 2 3 4 5; do
  if "${FIREBASE[@]}" deploy --only hosting --project "$PROJECT_ID"; then
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
