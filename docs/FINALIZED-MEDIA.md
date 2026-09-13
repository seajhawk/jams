# Finalized recording integrity

New upload completion locks the video row and copies the original and optional
poster into fresh `org/video/finalized/uuid/name` blob paths. Source ETags pin the
copy to the bytes whose size was checked. Each destination must be new, and the
copy must report success before the database points readers or workers at it.
Client upload SAS credentials remain scoped to the original upload paths.

This protects accepted media from reuse of those client credentials. It is not
Azure immutable-storage/WORM retention: trusted storage administrators and the
future deletion workflow can still modify or delete server-owned copies.

Completion is a one-way transition. Identical metadata retries return the accepted
record; conflicting metadata or a late failure notification cannot change it.
Concurrent completion requests serialize on the video row. Failed uploads require
a new upload rather than reviving the old row.

Storage and PostgreSQL do not share a transaction. Failed copies or rolled-back
database transactions can leave unused destination blobs. Upload sources also
remain until cleanup; their credentials may be reused until the original 15-minute
expiry. Cleanup and complete recording deletion are the next milestone. The
declared-original quota is not a physical storage cap: it excludes these copies,
posters and derived artifacts. Existing accepted rows are not migrated by this
change; the new guarantee applies to recordings completed through this code.

The pipeline E2E overwrites the old upload source after acceptance, compares the
accepted recording's SHA-256 to the source fixture, and checks that transferring
the old write SAS to the accepted path returns 403. Recovery fault
injection uses the local harness's trusted Azurite connection to corrupt/restore
only the freshly accepted recording. It no longer treats an old client write SAS
as permission to modify accepted media.
