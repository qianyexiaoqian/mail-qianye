"""主密碼加密：scrypt 從主密碼派生密鑰，AES-256-GCM 加密單個字段。

密文格式："enc1:" + base64(12 字節 nonce + 密文 + 16 字節 tag)。
沒有前綴的值視為明文（設置主密碼前的舊數據），讀取時原樣返回。
"""
import base64
import os

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

PREFIX = "enc1:"
SCRYPT_N = 2 ** 15
VERIFIER = "mail-manager-unlock-check"


class WrongPassword(Exception):
    pass


def new_salt():
    return base64.b64encode(os.urandom(16)).decode()


def derive_key(password, salt_b64, n=SCRYPT_N):
    salt = base64.b64decode(salt_b64)
    return Scrypt(salt=salt, length=32, n=n, r=8, p=1).derive(password.encode("utf-8"))


class Cipher:
    def __init__(self, key):
        self._aes = AESGCM(key)

    def encrypt(self, text):
        if not text:
            return ""
        nonce = os.urandom(12)
        return PREFIX + base64.b64encode(nonce + self._aes.encrypt(nonce, text.encode("utf-8"), None)).decode()

    def decrypt(self, value):
        if not value or not value.startswith(PREFIX):
            return value or ""
        raw = base64.b64decode(value[len(PREFIX):])
        try:
            return self._aes.decrypt(raw[:12], raw[12:], None).decode("utf-8")
        except InvalidTag:
            raise WrongPassword("解密失敗")

    def check(self, verifier):
        """驗證主密碼：能解開校驗串即為正確。"""
        try:
            return self.decrypt(verifier) == VERIFIER
        except WrongPassword:
            return False
