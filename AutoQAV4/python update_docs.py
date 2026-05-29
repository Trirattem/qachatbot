import re
import os
import shutil
from datetime import datetime

ENV_PATH = ".env"
TARGET_KEY = "GOOGLE_DOCUMENT_ID"
HISTORY_FILE = "doc_id_history.txt"


def load_env_lines(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.readlines()


def get_value(lines, key):
    for line in lines:
        m = re.match(rf"^{re.escape(key)}\s*=\s*(.+)", line.rstrip())
        if m:
            return m.group(1).strip()
    return None


def apply_to_env(lines, key, new_val):
    return [
        re.sub(rf"^({re.escape(key)}\s*=\s*).+",
               lambda x: f"{x.group(1)}{new_val}", line)
        for line in lines
    ]


def doc_url(doc_id):
    return f"https://docs.google.com/document/d/{doc_id}/edit"


def save_history(old_id, new_id):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    sep = "-" * 60
    header_needed = not os.path.exists(HISTORY_FILE) or os.path.getsize(HISTORY_FILE) == 0

    with open(HISTORY_FILE, "a", encoding="utf-8") as f:
        if header_needed:
            f.write("= ประวัติการเปลี่ยน GOOGLE_DOCUMENT_ID =\n")
        f.write(
            f"\n{sep}\n"
            f"  เวลา     : {timestamp}\n"
            f"  ID เก่า  : {old_id}\n"
            f"  ลิ้งค์   : {doc_url(old_id)}\n"
            f"  ID ใหม่  : {new_id}\n"
            f"  ลิ้งค์   : {doc_url(new_id)}\n"
            f"{sep}\n"
        )
    print(f"  บันทึกประวัติไว้ที่ : {HISTORY_FILE}")


def show_history():
    if not os.path.exists(HISTORY_FILE):
        print("\n  ยังไม่มีประวัติการเปลี่ยน ID")
        return
    print("")
    with open(HISTORY_FILE, "r", encoding="utf-8") as f:
        print(f.read())


def header(text):
    print("")
    print("=" * 60)
    print(f"  {text}")
    print("=" * 60)


def divider():
    print("-" * 60)


def main():
    header("Update Google Document ID")

    if not os.path.exists(ENV_PATH):
        print(f"\n  ERROR: ไม่พบไฟล์ {ENV_PATH}")
        print("  กรุณารันสคริปต์นี้จาก root folder ของ project")
        return

    lines = load_env_lines(ENV_PATH)
    current_id = get_value(lines, TARGET_KEY)

    if current_id is None:
        print(f"\n  ERROR: ไม่พบ {TARGET_KEY} ใน .env")
        return

    print("")
    divider()
    print(f"  {TARGET_KEY} (ปัจจุบัน)")
    print(f"  ID      : {current_id}")
    print(f"  ลิ้งค์  : {doc_url(current_id)}")
    divider()

    print("")
    print("  [1] เปลี่ยน Document ID")
    print("  [2] ดูประวัติการเปลี่ยน ID ทั้งหมด")
    print("  [3] ออก")
    print("")
    choice = input("  เลือก (1/2/3): ").strip()

    if choice == "2":
        show_history()
        return
    elif choice == "3" or choice == "":
        print("  ออกจากโปรแกรม")
        return
    elif choice != "1":
        print("  ตัวเลือกไม่ถูกต้อง")
        return

    print("")
    new_id = input("  ใส่ Document ID ใหม่ (กด Enter เพื่อคงเดิม): ").strip()

    if not new_id:
        print("  ไม่มีการเปลี่ยนแปลง")
        return

    if new_id == current_id:
        print("  ID เหมือนเดิม ไม่มีการเปลี่ยนแปลง")
        return

    print("")
    divider()
    print(f"  ID เก่า     : {current_id}")
    print(f"  ลิ้งค์เก่า  : {doc_url(current_id)}")
    print(f"  ID ใหม่     : {new_id}")
    print(f"  ลิ้งค์ใหม่  : {doc_url(new_id)}")
    divider()

    confirm = input("\n  ยืนยันบันทึกลง .env ไหม? (y/n): ").strip().lower()
    if confirm != "y":
        print("  ยกเลิกการบันทึก")
        return

    backup_path = f"{ENV_PATH}.backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    shutil.copy2(ENV_PATH, backup_path)
    print(f"  สำรอง .env ไว้ที่  : {backup_path}")

    new_lines = apply_to_env(lines, TARGET_KEY, new_id)
    with open(ENV_PATH, "w", encoding="utf-8") as f:
        f.writelines(new_lines)
    print("  บันทึกลง .env แล้ว")

    save_history(current_id, new_id)

    print("\n  เสร็จสิ้น\n")


if __name__ == "__main__":
    main()