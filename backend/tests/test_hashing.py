from packages.auth.hashing import hash_password, verify_password


def test_long_thai_password_hashes_and_verifies() -> None:
    # 30 Thai letters = 90 UTF-8 bytes, past bcrypt's 72-byte limit.
    pw = "รหัสผ่านยาวมากสำหรับทดสอบระบบนะ"
    assert len(pw.encode()) > 72
    hashed = hash_password(pw)
    assert verify_password(pw, hashed)
    assert not verify_password("wrong-password", hashed)


def test_short_password_round_trip() -> None:
    hashed = hash_password("hunter22")
    assert verify_password("hunter22", hashed)
    assert not verify_password("hunter23", hashed)
