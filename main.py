"""
Hospital Bed Finder API — hospitals (beds + doctors), patient accounts, AI chat.

Set OPENAI_API_KEY for ChatGPT-style replies (optional; demo text if unset).
Run: uvicorn main:app --reload --port 8088
"""
from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

import bcrypt
import httpx
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from pydantic import BaseModel, Field

BASE = Path(__file__).resolve().parent
ROOT = BASE.parent
DATA_JSON = ROOT / "data" / "hospitals.json"
DB_PATH = BASE / "hbf.db"

SECRET_KEY = os.environ.get("HBF_SECRET_KEY", "dev-only-change-me")
ALGORITHM = "HS256"
ACCESS_HOURS = 8
OPENAI_KEY = os.environ.get("OPENAI_API_KEY", "").strip()
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")

bearer = HTTPBearer(auto_error=False)


def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(
            plain.encode("utf-8"), password_hash.encode("utf-8")
        )
    except ValueError:
        return False


app = FastAPI(title="Hospital Bed Finder API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:8765",
        "http://127.0.0.1:8765",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
        "http://localhost:8088",
        "http://127.0.0.1:8088",
        "null",
    ],
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    conn = connect()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS hospitals (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          address TEXT NOT NULL,
          lat REAL NOT NULL,
          lng REAL NOT NULL,
          beds_available INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS hospital_users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hospital_id TEXT NOT NULL UNIQUE,
          username TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          FOREIGN KEY (hospital_id) REFERENCES hospitals(id)
        );
        CREATE TABLE IF NOT EXISTS doctors (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hospital_id TEXT NOT NULL,
          name TEXT NOT NULL,
          specialty TEXT NOT NULL,
          is_available INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (hospital_id) REFERENCES hospitals(id)
        );
        CREATE TABLE IF NOT EXISTS patients (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS chat_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          patient_id INTEGER NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (patient_id) REFERENCES patients(id)
        );
        """
    )
    with open(DATA_JSON, encoding="utf-8") as f:
        rows = json.load(f)
    for r in rows:
        conn.execute(
            """
            INSERT INTO hospitals (id, name, address, lat, lng, beds_available)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              name=excluded.name,
              address=excluded.address,
              lat=excluded.lat,
              lng=excluded.lng
            """,
            (
                r["id"],
                r["name"],
                r["address"],
                r["lat"],
                r["lng"],
                r.get("beds_available", 0),
            ),
        )
        hid = r["id"]
        demo_password = hid
        if conn.execute(
            "SELECT 1 FROM hospital_users WHERE hospital_id = ?", (hid,)
        ).fetchone():
            continue
        conn.execute(
            """
            INSERT INTO hospital_users (hospital_id, username, password_hash)
            VALUES (?, ?, ?)
            """,
            (hid, hid, hash_password(demo_password)),
        )
    conn.commit()
    conn.close()


@app.on_event("startup")
def startup() -> None:
    init_db()


class LoginBody(BaseModel):
    username: str = Field(min_length=1)
    password: str = Field(min_length=1)


class PatientRegisterBody(BaseModel):
    username: str = Field(min_length=3, max_length=64)
    password: str = Field(min_length=6, max_length=128)


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"


class BedsPatch(BaseModel):
    beds_available: int = Field(ge=0, le=50000)


class DoctorCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    specialty: str = Field(min_length=1, max_length=200)
    is_available: bool = True


class DoctorPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    specialty: str | None = Field(default=None, min_length=1, max_length=200)
    is_available: bool | None = None


class ChatMessageIn(BaseModel):
    message: str = Field(min_length=1, max_length=8000)


def create_hospital_token(hospital_id: str, username: str) -> str:
    exp = int((datetime.now(timezone.utc) + timedelta(hours=ACCESS_HOURS)).timestamp())
    return jwt.encode(
        {
            "sub": username,
            "hospital_id": hospital_id,
            "role": "hospital",
            "exp": exp,
        },
        SECRET_KEY,
        algorithm=ALGORITHM,
    )


def create_patient_token(patient_id: int, username: str) -> str:
    exp = int((datetime.now(timezone.utc) + timedelta(hours=ACCESS_HOURS)).timestamp())
    return jwt.encode(
        {
            "sub": username,
            "patient_id": patient_id,
            "role": "patient",
            "exp": exp,
        },
        SECRET_KEY,
        algorithm=ALGORITHM,
    )


def decode_token(token: str) -> dict:
    return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])


def get_current_hospital_id(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
) -> str:
    if creds is None or creds.scheme.lower() != "bearer":
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = decode_token(creds.credentials)
        if payload.get("role") == "patient":
            raise HTTPException(status_code=401, detail="Hospital staff token required")
        # Tokens issued before "role" was added still carry hospital_id only
        hid = payload.get("hospital_id")
        if not hid or not isinstance(hid, str):
            raise HTTPException(status_code=401, detail="Invalid token")
        return hid
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")


def get_current_patient_id(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
) -> int:
    if creds is None or creds.scheme.lower() != "bearer":
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = decode_token(creds.credentials)
        if payload.get("role") != "patient":
            raise HTTPException(status_code=401, detail="Patient account required")
        pid = payload.get("patient_id")
        if pid is None:
            raise HTTPException(status_code=401, detail="Invalid token")
        return int(pid)
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")


@app.post("/api/auth/login", response_model=TokenOut)
def hospital_login(body: LoginBody) -> TokenOut:
    conn = connect()
    row = conn.execute(
        """
        SELECT u.hospital_id, u.password_hash
        FROM hospital_users u
        WHERE u.username = ?
        """,
        (body.username.strip(),),
    ).fetchone()
    conn.close()
    if row is None or not verify_password(body.password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="Incorrect username or password")
    token = create_hospital_token(row["hospital_id"], body.username.strip())
    return TokenOut(access_token=token)


@app.post("/api/auth/patient/register", response_model=TokenOut)
def patient_register(body: PatientRegisterBody) -> TokenOut:
    uname = body.username.strip()
    conn = connect()
    try:
        conn.execute(
            "INSERT INTO patients (username, password_hash) VALUES (?, ?)",
            (uname, hash_password(body.password)),
        )
        conn.commit()
        pid = conn.execute(
            "SELECT id FROM patients WHERE username = ?", (uname,)
        ).fetchone()["id"]
    except sqlite3.IntegrityError:
        conn.close()
        raise HTTPException(status_code=400, detail="Username already taken")
    conn.close()
    return TokenOut(access_token=create_patient_token(int(pid), uname))


@app.post("/api/auth/patient/login", response_model=TokenOut)
def patient_login(body: LoginBody) -> TokenOut:
    conn = connect()
    row = conn.execute(
        "SELECT id, password_hash FROM patients WHERE username = ?",
        (body.username.strip(),),
    ).fetchone()
    conn.close()
    if row is None or not verify_password(body.password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="Incorrect username or password")
    return TokenOut(
        access_token=create_patient_token(int(row["id"]), body.username.strip())
    )


@app.get("/api/hospitals")
def list_hospitals() -> list[dict]:
    conn = connect()
    cur = conn.execute(
        """
        SELECT id, name, address, lat, lng, beds_available
        FROM hospitals
        ORDER BY name
        """
    )
    out = [dict(r) for r in cur.fetchall()]
    conn.close()
    return out


@app.get("/api/public/doctors-by-hospital")
def public_doctors_by_hospital() -> dict[str, list[dict]]:
    conn = connect()
    cur = conn.execute(
        """
        SELECT id, hospital_id, name, specialty, is_available
        FROM doctors
        WHERE is_available = 1
        ORDER BY specialty, name
        """
    )
    grouped: dict[str, list[dict]] = {}
    for r in cur.fetchall():
        d = dict(r)
        hid = d.pop("hospital_id")
        grouped.setdefault(hid, []).append(d)
    conn.close()
    return grouped


@app.get("/api/me/hospital")
def my_hospital(hospital_id: str = Depends(get_current_hospital_id)) -> dict:
    conn = connect()
    row = conn.execute(
        """
        SELECT id, name, address, lat, lng, beds_available
        FROM hospitals WHERE id = ?
        """,
        (hospital_id,),
    ).fetchone()
    conn.close()
    if row is None:
        raise HTTPException(status_code=404, detail="Hospital not found")
    return dict(row)


@app.patch("/api/me/hospital/beds")
def patch_my_beds(
    body: BedsPatch, hospital_id: str = Depends(get_current_hospital_id)
) -> dict:
    conn = connect()
    conn.execute(
        "UPDATE hospitals SET beds_available = ? WHERE id = ?",
        (body.beds_available, hospital_id),
    )
    conn.commit()
    row = conn.execute(
        "SELECT id, name, address, lat, lng, beds_available FROM hospitals WHERE id = ?",
        (hospital_id,),
    ).fetchone()
    conn.close()
    if row is None:
        raise HTTPException(status_code=404, detail="Hospital not found")
    return dict(row)


@app.get("/api/me/doctors")
def list_my_doctors(hospital_id: str = Depends(get_current_hospital_id)) -> list[dict]:
    conn = connect()
    cur = conn.execute(
        """
        SELECT id, hospital_id, name, specialty, is_available, created_at
        FROM doctors
        WHERE hospital_id = ?
        ORDER BY specialty, name
        """,
        (hospital_id,),
    )
    out = [dict(r) for r in cur.fetchall()]
    conn.close()
    return out


@app.post("/api/me/doctors")
def create_doctor(
    body: DoctorCreate, hospital_id: str = Depends(get_current_hospital_id)
) -> dict:
    conn = connect()
    cur = conn.execute(
        """
        INSERT INTO doctors (hospital_id, name, specialty, is_available)
        VALUES (?, ?, ?, ?)
        """,
        (hospital_id, body.name.strip(), body.specialty.strip(), 1 if body.is_available else 0),
    )
    conn.commit()
    doc_id = int(cur.lastrowid)
    row = conn.execute(
        "SELECT id, hospital_id, name, specialty, is_available, created_at FROM doctors WHERE id = ?",
        (doc_id,),
    ).fetchone()
    conn.close()
    return dict(row)


@app.patch("/api/me/doctors/{doctor_id}")
def patch_doctor(
    doctor_id: int,
    body: DoctorPatch,
    hospital_id: str = Depends(get_current_hospital_id),
) -> dict:
    conn = connect()
    row = conn.execute(
        "SELECT id FROM doctors WHERE id = ? AND hospital_id = ?",
        (doctor_id, hospital_id),
    ).fetchone()
    if row is None:
        conn.close()
        raise HTTPException(status_code=404, detail="Doctor not found")
    fields: list[str] = []
    vals: list = []
    if body.name is not None:
        fields.append("name = ?")
        vals.append(body.name.strip())
    if body.specialty is not None:
        fields.append("specialty = ?")
        vals.append(body.specialty.strip())
    if body.is_available is not None:
        fields.append("is_available = ?")
        vals.append(1 if body.is_available else 0)
    if not fields:
        conn.close()
        raise HTTPException(status_code=400, detail="No fields to update")
    vals.append(doctor_id)
    conn.execute(
        f"UPDATE doctors SET {', '.join(fields)} WHERE id = ?",
        vals,
    )
    conn.commit()
    row = conn.execute(
        "SELECT id, hospital_id, name, specialty, is_available, created_at FROM doctors WHERE id = ?",
        (doctor_id,),
    ).fetchone()
    conn.close()
    return dict(row)


@app.delete("/api/me/doctors/{doctor_id}")
def delete_doctor(
    doctor_id: int, hospital_id: str = Depends(get_current_hospital_id)
) -> dict:
    conn = connect()
    cur = conn.execute(
        "DELETE FROM doctors WHERE id = ? AND hospital_id = ?",
        (doctor_id, hospital_id),
    )
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="Doctor not found")
    return {"ok": True}


def _hospitals_summary_for_ai() -> str:
    conn = connect()
    cur = conn.execute(
        "SELECT id, name, address, beds_available FROM hospitals ORDER BY name"
    )
    lines = []
    for r in cur.fetchall():
        lines.append(
            f"- {r['name']} (id {r['id']}): {r['address']}; beds reported: {r['beds_available']}"
        )
    conn.close()
    return "\n".join(lines)


def _doctors_summary_for_ai() -> str:
    conn = connect()
    cur = conn.execute(
        """
        SELECT h.name AS hospital_name, d.name AS doctor_name, d.specialty, d.is_available
        FROM doctors d
        JOIN hospitals h ON h.id = d.hospital_id
        WHERE d.is_available = 1
        ORDER BY h.name, d.specialty, d.name
        """
    )
    lines = []
    for r in cur.fetchall():
        lines.append(
            f"- {r['doctor_name']} ({r['specialty']}) at {r['hospital_name']}"
        )
    conn.close()
    return "\n".join(lines) if lines else "- (No doctors listed yet by hospitals.)"


def _demo_chat_reply(user_message: str) -> str:
    return (
        "[Demo mode — add OPENAI_API_KEY on the server for full AI.] "
        "I’m a general guide for the Hospital Bed Finder in San Pablo City. "
        "I’m not a doctor and I can’t diagnose or prescribe. "
        "For emergencies, call your local emergency number or go to the nearest ER. "
        "You asked: "
        + user_message[:200]
        + ("…" if len(user_message) > 200 else "")
        + " — For medical concerns, please contact a licensed professional or visit a hospital from the map."
    )


def _openai_chat(messages: list[dict]) -> str:
    if not OPENAI_KEY:
        u = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
        return _demo_chat_reply(u)

    with httpx.Client(timeout=90.0) as client:
        r = client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {OPENAI_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": OPENAI_MODEL,
                "messages": messages,
                "max_tokens": 900,
            },
        )
        if r.status_code >= 400:
            raise HTTPException(
                status_code=502,
                detail="AI service error. Check OPENAI_API_KEY and model name.",
            )
        data = r.json()
        try:
            return data["choices"][0]["message"]["content"].strip()
        except (KeyError, IndexError):
            raise HTTPException(status_code=502, detail="Unexpected AI response")


@app.post("/api/patient/chat")
def patient_chat(
    body: ChatMessageIn, patient_id: int = Depends(get_current_patient_id)
) -> dict:
    conn = connect()
    conn.execute(
        "INSERT INTO chat_messages (patient_id, role, content) VALUES (?, 'user', ?)",
        (patient_id, body.message.strip()),
    )
    conn.commit()

    cur = conn.execute(
        """
        SELECT role, content FROM chat_messages
        WHERE patient_id = ?
        ORDER BY id DESC
        LIMIT 24
        """,
        (patient_id,),
    )
    history = list(cur.fetchall())[::-1]

    hospitals_block = _hospitals_summary_for_ai()
    doctors_block = _doctors_summary_for_ai()
    system = (
        "You are a helpful assistant for the Hospital Bed Finder web app in San Pablo City, Laguna, Philippines.\n"
        "You are NOT a medical professional. Never diagnose, prescribe medication, or give definitive medical advice. "
        "For emergencies, tell the user to call emergency services or go to the nearest hospital ER immediately.\n"
        "You may help with: how to use the app, general information about listed hospitals, and non-clinical guidance.\n\n"
        "Hospitals in the app:\n"
        f"{hospitals_block}\n\n"
        "Doctors currently listed as available (from hospital staff entries):\n"
        f"{doctors_block}\n"
    )

    messages: list[dict] = [{"role": "system", "content": system}]
    for row in history:
        role = row["role"]
        if role not in ("user", "assistant"):
            continue
        messages.append({"role": role, "content": row["content"]})

    try:
        answer = _openai_chat(messages)
    except HTTPException:
        conn.close()
        raise

    conn.execute(
        "INSERT INTO chat_messages (patient_id, role, content) VALUES (?, 'assistant', ?)",
        (patient_id, answer),
    )
    conn.commit()
    conn.close()
    return {"reply": answer, "demo": not bool(OPENAI_KEY)}


@app.get("/api/patient/chat/history")
def patient_chat_history(
    patient_id: int = Depends(get_current_patient_id),
) -> list[dict]:
    conn = connect()
    cur = conn.execute(
        """
        SELECT id, role, content, created_at
        FROM chat_messages
        WHERE patient_id = ?
        ORDER BY id ASC
        LIMIT 200
        """,
        (patient_id,),
    )
    out = [dict(r) for r in cur.fetchall()]
    conn.close()
    return out


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "ai": bool(OPENAI_KEY)}
