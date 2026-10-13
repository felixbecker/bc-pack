/**
 * Reframe Lock — src/mediainfo.js
 *
 * Parses a clip's source frame size out of Premiere's metadata strings.
 *
 * Why this exists: the UXP API exposes the SEQUENCE frame size directly
 * (`SequenceSettings.getVideoFrameRect()`), but nothing on `ProjectItem`
 * returns the source media's pixel dimensions. The only route is the project
 * metadata, where Premiere keeps the intrinsic column
 * `Column.Intrinsic.VideoInfo` in the shape "1920 x 1080 (1.0)" — width,
 * height and pixel aspect ratio.
 *
 * Pure string handling, no Premiere import, so the parsing is unit-testable.
 * It is also deliberately forgiving: the exact serialization of
 * `getProjectColumnsMetadata()` is not documented and has changed shape
 * between versions, so the parser works on whatever it is handed (XML, JSON or
 * a bare string) and reports HOW it got its answer, so a wrong read is
 * visible in the log rather than silently believed.
 */

/**
 * Plausible bounds for a video frame dimension in pixels. Keeps the fallback
 * scan from picking up a timecode, a date or a bitrate that happens to be
 * formatted with an "x".
 */
const MIN_DIMENSION = 16;
const MAX_DIMENSION = 65536;

function plausible(width, height) {
    return (
        width >= MIN_DIMENSION &&
        height >= MIN_DIMENSION &&
        width <= MAX_DIMENSION &&
        height <= MAX_DIMENSION
    );
}

/**
 * Extracts "<width> x <height>" and an optional "(<pixelAspect>)" from a
 * single value string such as "1920 x 1080 (1.0)".
 */
function parseVideoInfoValue(value) {
    if (typeof value !== "string") return null;
    const match = value.match(/(\d{2,5})\s*[x×]\s*(\d{2,5})/);
    if (!match) return null;

    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!plausible(width, height)) return null;

    const frame = { width: width, height: height, pixelAspect: 1 };

    // The parenthesised number after the dimensions is the pixel aspect ratio.
    const par = value.slice(match.index + match[0].length).match(/\(\s*([\d.]+)\s*\)/);
    if (par) {
        const parsed = Number(par[1]);
        if (isFinite(parsed) && parsed > 0) frame.pixelAspect = parsed;
    }
    return frame;
}

/**
 * Finds the source frame size in a metadata blob.
 *
 * Tried in order of trustworthiness:
 *   1. the value of a field explicitly named like the intrinsic VideoInfo
 *      column — unambiguous when present,
 *   2. any "W x H" pattern in the blob — a guess, and reported as one.
 *
 * @param {string} text
 * @returns {?{width:number, height:number, pixelAspect:number, via:string}}
 */
function parseSourceFrame(text) {
    if (typeof text !== "string" || !text) return null;

    /*
     * Stage 1: locate the VideoInfo field, then read the value that follows it.
     * Covers the XML form (<...VideoInfo>1920 x 1080 (1.0)</...>), the JSON
     * form ("Column.Intrinsic.VideoInfo":"1920 x 1080 (1.0)") and the
     * attribute form, by simply taking the text after the field name and
     * letting the dimension regex find the numbers in it.
     */
    const marker = /videoinfo/i.exec(text);
    if (marker) {
        const tail = text.slice(marker.index + marker[0].length, marker.index + 400);
        const parsed = parseVideoInfoValue(tail);
        if (parsed) {
            parsed.via = "Column.Intrinsic.VideoInfo";
            return parsed;
        }
    }

    const fallback = parseVideoInfoValue(text);
    if (fallback) {
        fallback.via = "Mustersuche im Metadatenblock (unsicher)";
        return fallback;
    }

    return null;
}

module.exports = {
    parseVideoInfoValue: parseVideoInfoValue,
    parseSourceFrame: parseSourceFrame,
    MIN_DIMENSION: MIN_DIMENSION,
    MAX_DIMENSION: MAX_DIMENSION
};
