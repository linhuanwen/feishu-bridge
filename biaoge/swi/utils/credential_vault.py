"""
凭证保险箱 — 使用 Fernet 对称加密保护敏感数据。
密钥存储在项目目录下的 .key 文件中，首次自动生成。
"""
from pathlib import Path
from cryptography.fernet import Fernet


class CredentialVault:
    """
    简单的凭证加密存储。

    用法:
        vault = CredentialVault(key_dir="data")
        encrypted = vault.encrypt("my-secret-token")
        decrypted = vault.decrypt(encrypted)  # "my-secret-token"
    """

    def __init__(self, key_dir: str = "data"):
        self.key_path = Path(key_dir) / ".vault_key"
        self._fernet = self._load_or_create_key()

    def _load_or_create_key(self) -> Fernet:
        """加载已有密钥，不存在则生成新密钥。"""
        if self.key_path.exists():
            with open(self.key_path, "rb") as f:
                key = f.read()
        else:
            key = Fernet.generate_key()
            self.key_path.parent.mkdir(parents=True, exist_ok=True)
            with open(self.key_path, "wb") as f:
                f.write(key)
            # 设置文件为隐藏（Windows）
            import os
            try:
                os.system(f'attrib +h "{self.key_path}"')
            except Exception:
                pass
        return Fernet(key)

    def encrypt(self, plaintext: str) -> str:
        """加密明文字符串，返回 base64 密文。"""
        return self._fernet.encrypt(plaintext.encode("utf-8")).decode("utf-8")

    def decrypt(self, ciphertext: str) -> str:
        """解密密文，返回原始明文字符串。"""
        return self._fernet.decrypt(ciphertext.encode("utf-8")).decode("utf-8")
