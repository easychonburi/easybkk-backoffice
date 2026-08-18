#!/usr/bin/env bash
set -euo pipefail

SITE_URL="https://easy-bubble-backoffice.web.app"
IMPORT_FILE="${1:-${HOME}/easy-bubble-firebase-export.json}"

if [[ ! -f "$IMPORT_FILE" ]]; then
  echo "ไม่พบไฟล์: $IMPORT_FILE"
  echo "กรุณากด Upload ใน Cloud Shell แล้วเลือก easy-bubble-firebase-export.json"
  exit 1
fi

while true; do
  read -r -s -p "PIN แอดมินที่ตั้งไว้ตอน deploy: " ADMIN_PIN_VALUE
  echo
  if [[ "$ADMIN_PIN_VALUE" =~ ^[0-9]{4}$ ]]; then break; fi
  echo "PIN ต้องเป็นตัวเลข 4 หลัก"
done

ADMIN_PIN="$ADMIN_PIN_VALUE" node migration/import.mjs "${SITE_URL}/api" "$IMPORT_FILE"
unset ADMIN_PIN_VALUE
echo "นำเข้าข้อมูลจาก Google Sheet เรียบร้อย"
