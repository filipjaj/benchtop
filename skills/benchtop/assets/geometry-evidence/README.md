# Source-specific geometry records

Start with variant-records.json. None of these records certifies an enclosure fit.

- YD-ESP32-S3: primary metric drawing, original Altium board, 121 native pad anchors,
  44 header anchors and explicit board polygon. No seller clone identity is inferred.
- drafts/yd-esp32-s3-mechanical-draft.json: 44 headers imported from that native file,
  turned 180 degrees so the USB end is at y=0. Body thickness, assembled height and
  electrical mapping are deliberately incomplete (unknown heights are null); check-parts must reject it until
  evidence fills these fields. Do not move it into assets/parts as a finished part.
- Three INMP441 seller records preserve their separate dimension claims and unknown
  pad geometry. The chip datasheet supplies electrical facts, not carrier geometry.
- The originals (seller pages, photos, datasheets, CAD files) are not distributed: their
  authors keep their rights. Each source record keeps its URL and SHA256; `local_path`
  names where a fetched copy goes (`sources/<sha256>.<ext>`, git-ignored). Fetch from the
  URL and compare the hash to confirm you are reading the same file.
- library-audit.json inventories current bundled part declarations and source limits.
  A matching hash establishes the file reviewed, not physical correctness.
