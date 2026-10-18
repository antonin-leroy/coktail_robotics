from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

STUDIO_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=STUDIO_DIR / ".env", extra="ignore")

    hf_token: str | None = None
    hf_namespace: str | None = None

    database_url: str = "postgresql://studio:studio@localhost:5433/studio"
    s3_endpoint: str = "http://localhost:9000"
    s3_access_key: str = "studio"
    s3_secret_key: str = "studio-secret"
    s3_bucket: str = "studio-previews"

    studio_fake_jobs: bool = False
    studio_job_image: str = "huggingface/lerobot-gpu:latest"

    @field_validator("hf_token", "hf_namespace", mode="before")
    @classmethod
    def blank_is_unset(cls, value):
        return value or None


settings = Settings()
