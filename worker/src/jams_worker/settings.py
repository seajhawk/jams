"""Environment configuration for the worker."""

from __future__ import annotations

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = Field(alias="DATABASE_URL")
    azure_storage_connection_string: str = Field(alias="AZURE_STORAGE_CONNECTION_STRING")
    jobs_queue_name: str = "analysis-jobs"
    poison_queue_name: str = "analysis-jobs-poison"
    lease_duration_seconds: int = 300
    visibility_timeout_seconds: int = 300
    visibility_renew_interval_seconds: int = 60

    model_config = SettingsConfigDict(extra="ignore")
