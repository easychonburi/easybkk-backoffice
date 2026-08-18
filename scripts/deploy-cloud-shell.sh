#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="easy-bubble-backoffice"
SITE_URL="https://${PROJECT_ID}.web.app"
REGION="asia-southeast3"
SERVICE_ACCOUNT="easy-bubble-api@${PROJECT_ID}.iam.gserviceaccount.com"

if command -v firebase >/dev/null 2>&1; then
  FIREBASE=(firebase)
else
  FIREBASE=(npx --yes firebase-tools@latest)
fi

echo "[1/6] ตรวจบัญชีและ Firebase Project"
"${FIREBASE[@]}" projects:list >/dev/null

echo "[2/6] เปิดบริการที่ระบบต้องใช้"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com firestore.googleapis.com --project "$PROJECT_ID"

echo "[3/6] ติดตั้ง Backend"
npm --prefix functions ci --no-audit --no-fund

echo "[4/6] สร้างกุญแจความปลอดภัย"
APP_KEY_VALUE="$(openssl rand -hex 32)"
BOOTSTRAP_KEY_VALUE="$(openssl rand -hex 32)"
if gcloud secrets describe APP_ENCRYPTION_KEY --project "$PROJECT_ID" >/dev/null 2>&1; then
  printf '%s' "$APP_KEY_VALUE" | gcloud secrets versions add APP_ENCRYPTION_KEY --data-file=- --project "$PROJECT_ID"
else
  printf '%s' "$APP_KEY_VALUE" | gcloud secrets create APP_ENCRYPTION_KEY --replication-policy=automatic --data-file=- --project "$PROJECT_ID"
fi
if gcloud secrets describe BOOTSTRAP_KEY --project "$PROJECT_ID" >/dev/null 2>&1; then
  printf '%s' "$BOOTSTRAP_KEY_VALUE" | gcloud secrets versions add BOOTSTRAP_KEY --data-file=- --project "$PROJECT_ID"
else
  printf '%s' "$BOOTSTRAP_KEY_VALUE" | gcloud secrets create BOOTSTRAP_KEY --replication-policy=automatic --data-file=- --project "$PROJECT_ID"
fi

if ! gcloud iam service-accounts describe "$SERVICE_ACCOUNT" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create easy-bubble-api --display-name="Easy Bubble API" --project "$PROJECT_ID"
fi
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${SERVICE_ACCOUNT}" --role="roles/datastore.user" --condition=None --quiet >/dev/null
gcloud secrets add-iam-policy-binding APP_ENCRYPTION_KEY --member="serviceAccount:${SERVICE_ACCOUNT}" --role="roles/secretmanager.secretAccessor" --project "$PROJECT_ID" --quiet >/dev/null
gcloud secrets add-iam-policy-binding BOOTSTRAP_KEY --member="serviceAccount:${SERVICE_ACCOUNT}" --role="roles/secretmanager.secretAccessor" --project "$PROJECT_ID" --quiet >/dev/null

echo "[5/6] Deploy Backend ที่ Bangkok"
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

echo "[6/6] Deploy Firestore Rules และหน้าเว็บ"
"${FIREBASE[@]}" deploy --only firestore,hosting --project "$PROJECT_ID"

while true; do
  read -r -s -p "ตั้ง PIN แอดมิน 4 หลัก (ใช้ PIN เดิมได้): " ADMIN_PIN
  echo
  if [[ "$ADMIN_PIN" =~ ^[0-9]{4}$ ]]; then break; fi
  echo "PIN ต้องเป็นตัวเลข 4 หลัก"
done

echo "สร้างผู้ดูแลระบบเริ่มต้น"
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
