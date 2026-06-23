const ALTALIS_LAYER =
  "https://services7.arcgis.com/hFo7GO2CrHDM1QVm/ArcGIS/rest/services/ATS/FeatureServer/0/query";
const FEDERAL_DLS_LAYER =
  "https://geo.sac-isc.gc.ca/geomatics/rest/services/ATRIS_PRD/DOMINION_LAND_SURVEY_E/MapServer/2/query";

const MERIDIANS = {
  1: -(97 + 27 / 60 + 28.41 / 3600),
  2: -102,
  3: -106,
  4: -110,
  5: -114,
  6: -118,
};

const sectionGrid = [
  [6, 5, 4, 3, 2, 1],
  [7, 8, 9, 10, 11, 12],
  [18, 17, 16, 15, 14, 13],
  [19, 20, 21, 22, 23, 24],
  [30, 29, 28, 27, 26, 25],
  [31, 32, 33, 34, 35, 36],
];

const lsdGrid = [
  [4, 3, 2, 1],
  [5, 6, 7, 8],
  [12, 11, 10, 9],
  [13, 14, 15, 16],
];

const quarterNames = {
  NE: "Northeast",
  NW: "Northwest",
  SE: "Southeast",
  SW: "Southwest",
};

const converterPanel = document.querySelector(".converter-panel");
const mapPanel = document.querySelector(".map-panel");
const form = document.querySelector("#converterForm");
const modeTabs = document.querySelectorAll(".mode-tab");
const landFields = document.querySelector("#landFields");
const coordinateFields = document.querySelector("#coordinateFields");
const clearButton = document.querySelector("#clearButton");
const copyButton = document.querySelector("#copyButton");
const divisionField = document.querySelector("#division");
const sectionField = document.querySelector("#section");
const townshipField = document.querySelector("#township");
const rangeField = document.querySelector("#range");
const meridianField = document.querySelector("#meridian");
const latitudeInput = document.querySelector("#latitudeInput");
const longitudeInput = document.querySelector("#longitudeInput");
const coordinateOutput = document.querySelector("#coordinateOutput");
const detailOutput = document.querySelector("#detailOutput");
const methodOutput = document.querySelector("#methodOutput");
const resultTitle = document.querySelector("#resultTitle");
const message = document.querySelector("#message");
const sourcePill = document.querySelector("#sourcePill");
const mapLink = document.querySelector("#mapLink");
const googleMapFrame = document.querySelector("#googleMapFrame");
const mapPlaceholder = document.querySelector("#mapPlaceholder");
const legalSummary = document.querySelector("#legalSummary");
const precisionSummary = document.querySelector("#precisionSummary");

let lastCoordinates = null;
let currentMode = "land";
let mapPanelHeightTarget = 0;
let lastConverterPanelWidth = 0;

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await convertFromForm();
});

modeTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    switchMode(tab.dataset.mode);
  });
});

clearButton.addEventListener("click", () => {
  resetToEmptyState();
});

copyButton.addEventListener("click", async () => {
  const value = coordinateOutput.textContent.trim();
  if (!value) {
    setMessage("Nothing to copy yet.", "warning");
    return;
  }

  try {
    await navigator.clipboard.writeText(value);
    setMessage(
      currentMode === "coordinates"
        ? "Copied land location to the clipboard."
        : "Copied coordinates to the clipboard.",
      "info"
    );
  } catch {
    setMessage("Clipboard access was blocked by the browser.", "warning");
  }
});

async function convertFromForm() {
  if (currentMode === "coordinates") {
    await convertCoordinatesFromForm();
    return;
  }

  await convertLandFromForm();
}

async function convertLandFromForm() {
  let input;

  try {
    input = readLandFormValues();
  } catch (error) {
    setMessage(error.message, "warning");
    return;
  }

  setBusy(true);
  setMessage("Looking up the selected land location...", "info");
  updateLegalSummary(input);

  try {
    const result = await resolveCoordinates(input);
    showCoordinateResult(input, result);
  } catch (error) {
    setMessage(error.message, "warning");
  } finally {
    setBusy(false);
  }
}

async function convertCoordinatesFromForm() {
  let input;

  try {
    input = readCoordinateFormValues();
  } catch (error) {
    setMessage(error.message, "warning");
    return;
  }

  setBusy(true);
  setMessage("Looking up the land location for those coordinates...", "info");
  updateGoogleMap(input.lat.toFixed(7), input.lon.toFixed(7));

  try {
    const result = await resolveLandLocation(input);
    showLandResult(input, result);
  } catch (error) {
    setMessage(error.message, "warning");
  } finally {
    setBusy(false);
  }
}

async function resolveCoordinates(input) {
  const attempts = [
    () => fetchAlbertaParcelCentroid(input),
    () => fetchFederalTownshipEstimate(input),
    () => localDlsEstimate(input),
  ];

  const failures = [];

  for (const attempt of attempts) {
    try {
      const result = await attempt();
      if (result) {
        return result;
      }
    } catch (error) {
      failures.push(error.message);
    }
  }

  throw new Error(
    failures.length
      ? failures[failures.length - 1]
      : "No matching land location was found."
  );
}

async function resolveLandLocation(input) {
  const attempts = [
    () => fetchAlbertaParcelAtPoint(input),
    () => fetchFederalTownshipAtPoint(input),
    () => localDlsReverseEstimate(input),
  ];

  const failures = [];

  for (const attempt of attempts) {
    try {
      const result = await attempt();
      if (result) {
        return result;
      }
    } catch (error) {
      failures.push(error.message);
    }
  }

  throw new Error(
    failures.length
      ? failures[failures.length - 1]
      : "No matching land location was found."
  );
}

async function fetchAlbertaParcelCentroid(input) {
  if (!["4", "5", "6"].includes(String(input.meridian))) {
    return null;
  }

  const division = parseDivision(input.division);
  const parts = [
    `M = ${input.meridian}`,
    `RGE = ${input.range}`,
    `TWP = ${input.township}`,
    `SEC = ${input.section}`,
  ];

  if (division.type === "quarter") {
    parts.push(`QS = '${division.value}'`);
  } else {
    parts.push(`LS = ${division.value}`);
  }

  const json = await arcgisQuery(ALTALIS_LAYER, {
    where: parts.join(" AND "),
    outFields: "M,RGE,TWP,SEC,QS,LS,DESCRIPTOR,ShortLegal,Shape__Area",
    returnGeometry: "true",
    outSR: "4326",
    geometryPrecision: "8",
    f: "json",
  });

  if (!json.features?.length) {
    return null;
  }

  const centroid = combinedFeatureCentroid(json.features);

  return {
    lat: centroid.lat,
    lon: centroid.lon,
    source: "Alberta ATS parcel fabric",
    confidence: "GIS centroid",
    method: "Direct lookup",
    methodDetail: "Direct lookup from Alberta ATS parcel fabric",
  };
}

async function fetchFederalTownshipEstimate(input) {
  const json = await arcgisQuery(FEDERAL_DLS_LAYER, {
    where: `TWP = ${input.township} AND RGE = ${input.range} AND MERIDIAN = 'W${input.meridian}'`,
    outFields: "DLS_ID,TWP,RGE,MERIDIAN",
    returnGeometry: "true",
    outSR: "4326",
    geometryPrecision: "8",
    f: "json",
  });

  if (!json.features?.length) {
    return null;
  }

  const rings = json.features[0].geometry?.rings;
  const bbox = boundingBox(rings);
  const fraction = sectionFraction(input);

  return {
    lat: bbox.minY + (bbox.maxY - bbox.minY) * fraction.y,
    lon: bbox.minX + (bbox.maxX - bbox.minX) * fraction.x,
    source: "Federal DLS township grid",
    confidence: "Section subdivision estimate",
    method: "Fallback",
    methodDetail: "Fallback: federal DLS grid estimate",
  };
}

async function fetchAlbertaParcelAtPoint(input) {
  const json = await arcgisQuery(ALTALIS_LAYER, {
    where: "1=1",
    geometry: `${input.lon},${input.lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "M,RGE,TWP,SEC,QS,LS,DESCRIPTOR,ShortLegal",
    returnGeometry: "false",
    f: "json",
  });

  if (!json.features?.length) {
    return null;
  }

  const attrs = json.features[0].attributes;
  const land = landFromAttributes(attrs);

  return {
    land,
    source: "Alberta ATS parcel fabric",
    confidence: "Point-in-polygon GIS lookup",
    method: "Direct lookup",
    methodDetail: "Direct lookup from Alberta ATS parcel fabric",
  };
}

async function fetchFederalTownshipAtPoint(input) {
  const json = await arcgisQuery(FEDERAL_DLS_LAYER, {
    where: "1=1",
    geometry: `${input.lon},${input.lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "DLS_ID,TWP,RGE,MERIDIAN",
    returnGeometry: "true",
    outSR: "4326",
    geometryPrecision: "8",
    f: "json",
  });

  if (!json.features?.length) {
    return null;
  }

  const feature = json.features[0];
  const bbox = boundingBox(feature.geometry?.rings);
  const township = Number(feature.attributes?.TWP);
  const range = Number(feature.attributes?.RGE);
  const meridian = parseMeridian(feature.attributes?.MERIDIAN);
  const fraction = {
    x: clamp((input.lon - bbox.minX) / (bbox.maxX - bbox.minX), 0, 0.999999),
    y: clamp((input.lat - bbox.minY) / (bbox.maxY - bbox.minY), 0, 0.999999),
  };
  const land = landFromTownshipFraction({
    township,
    range,
    meridian,
    fraction,
  });

  return {
    land,
    source: "Federal DLS township grid",
    confidence: "Section subdivision estimate",
    method: "Fallback",
    methodDetail: "Fallback: federal DLS grid estimate",
  };
}

function localDlsEstimate(input) {
  const meridianLon = MERIDIANS[input.meridian];
  if (!Number.isFinite(meridianLon)) {
    throw new Error("That meridian is not supported.");
  }

  const sectionPosition = findSectionPosition(input.section);
  const division = parseDivision(input.division);
  const local = localDivisionOffset(division);

  const milesNorth =
    (input.township - 1) * 6 + sectionPosition.row + local.y;
  const milesWest =
    input.range * 6 - (sectionPosition.col + local.x);
  const lat = 49 + milesNorth / 69.047;
  const milesPerDegreeLon = 69.172 * Math.cos((lat * Math.PI) / 180);
  const lon = meridianLon - milesWest / milesPerDegreeLon;

  return {
    lat,
    lon,
    source: "Local DLS math",
    confidence: "Approximate",
    method: "Fallback",
    methodDetail: "Fallback: local DLS math",
  };
}

function localDlsReverseEstimate(input) {
  const milesPerDegreeLon = 69.172 * Math.cos((input.lat * Math.PI) / 180);
  const milesNorth = (input.lat - 49) * 69.047;

  if (milesNorth < 0) {
    throw new Error("Coordinates are south of the supported DLS area.");
  }

  for (const [meridian, meridianLon] of Object.entries(MERIDIANS)) {
    const milesWest = (meridianLon - input.lon) * milesPerDegreeLon;

    if (milesWest < 0) {
      continue;
    }

    const township = Math.floor(milesNorth / 6) + 1;
    const range = Math.floor(milesWest / 6) + 1;

    if (township < 1 || township > 126 || range < 1 || range > 34) {
      continue;
    }

    const townshipY = milesNorth - (township - 1) * 6;
    const townshipX = range * 6 - milesWest;
    const fraction = {
      x: clamp(townshipX / 6, 0, 0.999999),
      y: clamp(townshipY / 6, 0, 0.999999),
    };
    const land = landFromTownshipFraction({
      township,
      range,
      meridian: Number(meridian),
      fraction,
    });

    return {
      land,
      source: "Local DLS math",
      confidence: "Approximate",
      method: "Fallback",
      methodDetail: "Fallback: local DLS math",
    };
  }

  throw new Error("Coordinates are outside the supported DLS range.");
}

async function arcgisQuery(url, params) {
  const query = new URLSearchParams(params);
  const response = await fetch(`${url}?${query.toString()}`);

  if (!response.ok) {
    throw new Error(`GIS request failed with status ${response.status}.`);
  }

  const json = await response.json();

  if (json.error) {
    throw new Error(json.error.message || "GIS request failed.");
  }

  return json;
}

function readLandFormValues() {
  return validateInput({
    division: divisionField.value,
    section: Number(sectionField.value),
    township: Number(townshipField.value),
    range: Number(rangeField.value),
    meridian: Number(meridianField.value),
  });
}

function readCoordinateFormValues() {
  const lat = Number(latitudeInput.value);
  const lon = Number(longitudeInput.value);

  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new Error("Latitude must be a number from -90 to 90.");
  }

  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new Error("Longitude must be a number from -180 to 180.");
  }

  return { lat, lon };
}

function validateInput(input) {
  if (!input.division) {
    throw new Error("Choose a quarter section or legal subdivision.");
  }

  assertRange(input.section, 1, 36, "Section");
  assertRange(input.township, 1, 126, "Township");
  assertRange(input.range, 1, 34, "Range");
  assertRange(input.meridian, 1, 6, "Meridian");

  return input;
}

function assertRange(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
  }
}

function parseDivision(value) {
  const [type, raw] = value.split(":");

  if (type === "Q") {
    return { type: "quarter", value: raw };
  }

  if (type === "L") {
    return { type: "lsd", value: Number(raw) };
  }

  throw new Error("Choose a quarter section or legal subdivision.");
}

function findSectionPosition(section) {
  for (let row = 0; row < sectionGrid.length; row += 1) {
    const col = sectionGrid[row].indexOf(section);
    if (col !== -1) {
      return { row, col };
    }
  }

  throw new Error("Section must be from 1 to 36.");
}

function localDivisionOffset(division) {
  if (division.type === "quarter") {
    return {
      NE: { x: 0.75, y: 0.75 },
      NW: { x: 0.25, y: 0.75 },
      SE: { x: 0.75, y: 0.25 },
      SW: { x: 0.25, y: 0.25 },
    }[division.value];
  }

  for (let row = 0; row < lsdGrid.length; row += 1) {
    const col = lsdGrid[row].indexOf(division.value);
    if (col !== -1) {
      return {
        x: (col + 0.5) / 4,
        y: (row + 0.5) / 4,
      };
    }
  }

  throw new Error("LSD must be from 1 to 16.");
}

function sectionFraction(input) {
  const sectionPosition = findSectionPosition(input.section);
  const division = parseDivision(input.division);
  const local = localDivisionOffset(division);

  return {
    x: (sectionPosition.col + local.x) / 6,
    y: (sectionPosition.row + local.y) / 6,
  };
}

function polygonCentroid(rings) {
  if (!Array.isArray(rings) || !rings.length) {
    throw new Error("The GIS service returned a feature without geometry.");
  }

  let areaSum = 0;
  let cxSum = 0;
  let cySum = 0;

  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i += 1) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[i + 1];
      const cross = x1 * y2 - x2 * y1;
      areaSum += cross;
      cxSum += (x1 + x2) * cross;
      cySum += (y1 + y2) * cross;
    }
  }

  const area = areaSum / 2;
  if (Math.abs(area) < 1e-12) {
    const points = rings.flat();
    const total = points.reduce(
      (sum, point) => ({ lon: sum.lon + point[0], lat: sum.lat + point[1] }),
      { lon: 0, lat: 0 }
    );
    return {
      lon: total.lon / points.length,
      lat: total.lat / points.length,
    };
  }

  return {
    lon: cxSum / (6 * area),
    lat: cySum / (6 * area),
  };
}

function combinedFeatureCentroid(features) {
  let totalWeight = 0;
  let latSum = 0;
  let lonSum = 0;

  for (const feature of features) {
    const centroid = polygonCentroid(feature.geometry?.rings);
    const weight =
      Number(feature.attributes?.Shape__Area) ||
      Math.abs(polygonSignedArea(feature.geometry?.rings)) ||
      1;

    totalWeight += weight;
    latSum += centroid.lat * weight;
    lonSum += centroid.lon * weight;
  }

  if (!totalWeight) {
    throw new Error("The GIS service returned geometry with no measurable area.");
  }

  return {
    lat: latSum / totalWeight,
    lon: lonSum / totalWeight,
  };
}

function polygonSignedArea(rings) {
  if (!Array.isArray(rings)) {
    return 0;
  }

  let areaSum = 0;

  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i += 1) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[i + 1];
      areaSum += x1 * y2 - x2 * y1;
    }
  }

  return areaSum / 2;
}

function boundingBox(rings) {
  const points = rings?.flat() || [];

  if (!points.length) {
    throw new Error("The DLS township grid did not include geometry.");
  }

  return points.reduce(
    (box, [x, y]) => ({
      minX: Math.min(box.minX, x),
      maxX: Math.max(box.maxX, x),
      minY: Math.min(box.minY, y),
      maxY: Math.max(box.maxY, y),
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    }
  );
}

function showCoordinateResult(input, result) {
  const lat = normalizeZero(result.lat).toFixed(7);
  const lon = normalizeZero(result.lon).toFixed(7);
  const formatted = `${lat}, ${lon}`;

  lastCoordinates = { lat: result.lat, lon: result.lon };
  resultTitle.textContent = "Latitude, Longitude";
  coordinateOutput.textContent = formatted;
  detailOutput.textContent = "";
  methodOutput.textContent = result.methodDetail;
  sourcePill.textContent = result.method;
  precisionSummary.textContent = `${result.source} - ${result.confidence}`;
  mapLink.href = `https://maps.google.com/maps?q=${lat},${lon}&z=14&t=k`;
  setMessage("", "info");
  updateLegalSummary(input);
  updateGoogleMap(lat, lon);
  syncMapPanelHeight();
}

function showLandResult(input, result) {
  const lat = normalizeZero(input.lat).toFixed(7);
  const lon = normalizeZero(input.lon).toFixed(7);

  lastCoordinates = { lat: input.lat, lon: input.lon };
  resultTitle.textContent = "Land location";
  coordinateOutput.textContent = result.land.short;
  detailOutput.textContent = result.land.detail;
  methodOutput.textContent = result.methodDetail;
  sourcePill.textContent = result.method;
  precisionSummary.textContent = `${result.source} - ${result.confidence}`;
  mapLink.href = `https://maps.google.com/maps?q=${lat},${lon}&z=14&t=k`;
  setMessage("", "info");
  legalSummary.textContent = result.land.short;
  updateGoogleMap(lat, lon);
  syncMapPanelHeight();
}

function normalizeZero(value) {
  return Math.abs(value) < 0.00000005 ? 0 : value;
}

function updateLegalSummary(input) {
  const division = parseDivision(input.division);
  const prefix =
    division.type === "quarter"
      ? `${division.value} 1/4`
      : `LSD ${String(division.value).padStart(2, "0")}`;

  legalSummary.textContent = `${prefix}-${input.section}-${input.township}-${input.range}-W${input.meridian}`;
}

function landFromAttributes(attrs) {
  return formatLandLocation({
    lsd: Number(attrs.LS),
    quarter: attrs.QS,
    section: Number(attrs.SEC),
    township: Number(attrs.TWP),
    range: Number(attrs.RGE),
    meridian: Number(attrs.M),
  });
}

function landFromTownshipFraction({ township, range, meridian, fraction }) {
  const sectionCol = Math.floor(clamp(fraction.x, 0, 0.999999) * 6);
  const sectionRow = Math.floor(clamp(fraction.y, 0, 0.999999) * 6);
  const section = sectionGrid[sectionRow][sectionCol];
  const localX = fraction.x * 6 - sectionCol;
  const localY = fraction.y * 6 - sectionRow;
  const lsdCol = Math.floor(clamp(localX, 0, 0.999999) * 4);
  const lsdRow = Math.floor(clamp(localY, 0, 0.999999) * 4);
  const lsd = lsdGrid[lsdRow][lsdCol];
  const quarter = `${localY >= 0.5 ? "N" : "S"}${localX >= 0.5 ? "E" : "W"}`;

  return formatLandLocation({
    lsd,
    quarter,
    section,
    township,
    range,
    meridian,
  });
}

function formatLandLocation({ lsd, quarter, section, township, range, meridian }) {
  const shortPrefix = quarter || (Number.isFinite(lsd) ? `LSD ${String(lsd).padStart(2, "0")}` : "");
  const short = `${shortPrefix} ${section}-${township}-${range}-W${meridian}`.trim();
  const quarterText = quarter ? `${quarterNames[quarter] || quarter} Quarter of ` : "";
  const lsdText = Number.isFinite(lsd) ? `LSD ${String(lsd).padStart(2, "0")} in ` : "";
  const detail =
    `${lsdText}${quarterText}Section ${section}, ` +
    `Township ${township}, Range ${range}, West of the ${ordinal(meridian)} Meridian`;

  return { short, detail };
}

function ordinal(value) {
  const suffixes = { 1: "st", 2: "nd", 3: "rd" };
  return `${value}${suffixes[value] || "th"}`;
}

function parseMeridian(value) {
  const match = String(value ?? "").match(/\d+/);
  if (!match) {
    throw new Error("The DLS grid returned a township without a meridian.");
  }

  return Number(match[0]);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function setMessage(text, tone) {
  message.textContent = text;
  message.classList.toggle("warning", tone === "warning");
}

function updateGoogleMap(lat, lon) {
  const query = encodeURIComponent(`${lat}, ${lon}`);
  googleMapFrame.src = `https://maps.google.com/maps?q=${query}&z=14&t=k&output=embed`;
  mapPlaceholder.hidden = true;
}

function clearGoogleMap() {
  googleMapFrame.removeAttribute("src");
  mapPlaceholder.hidden = false;
}

function setBusy(isBusy) {
  const button = document.querySelector("#convertButton");
  const label = button.querySelector(".button-label");
  button.disabled = isBusy;
  button.classList.toggle("is-loading", isBusy);
  button.setAttribute("aria-busy", String(isBusy));
  label.textContent = isBusy ? "Calculating..." : "Calculate";
  syncMapPanelHeight();
}

function switchMode(mode) {
  currentMode = mode === "coordinates" ? "coordinates" : "land";

  modeTabs.forEach((tab) => {
    const isActive = tab.dataset.mode === currentMode;
    tab.classList.toggle("is-active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
  });

  landFields.hidden = currentMode !== "land";
  coordinateFields.hidden = currentMode !== "coordinates";
  resetToEmptyState();
}

function syncMapPanelHeight() {
  const isSideBySide = window.matchMedia("(min-width: 1101px)").matches;

  if (!isSideBySide) {
    mapPanel.style.height = "";
    mapPanelHeightTarget = 0;
    lastConverterPanelWidth = 0;
    return;
  }

  if (lastConverterPanelWidth !== converterPanel.offsetWidth) {
    mapPanelHeightTarget = 0;
    lastConverterPanelWidth = converterPanel.offsetWidth;
  }

  mapPanelHeightTarget = Math.max(mapPanelHeightTarget, converterPanel.offsetHeight);
  mapPanel.style.height = `${mapPanelHeightTarget}px`;
}

function resetToEmptyState() {
  divisionField.value = "Q:SE";
  sectionField.value = "";
  townshipField.value = "";
  rangeField.value = "";
  meridianField.value = "4";
  latitudeInput.value = "";
  longitudeInput.value = "";
  resultTitle.textContent =
    currentMode === "coordinates" ? "Land location" : "Latitude, Longitude";
  coordinateOutput.textContent = "";
  detailOutput.textContent = "";
  methodOutput.textContent = "";
  mapLink.removeAttribute("href");
  sourcePill.textContent = "Ready";
  legalSummary.textContent = "No location entered";
  precisionSummary.textContent = "Ready to calculate";
  clearGoogleMap();
  setMessage(
    currentMode === "coordinates"
      ? "Enter latitude and longitude, then calculate."
      : "Enter a section, township, and range, then calculate.",
    "info"
  );
  syncMapPanelHeight();
}

const initialMode = new URLSearchParams(window.location.search).get("mode");
switchMode(initialMode === "coordinates" ? "coordinates" : "land");

if ("ResizeObserver" in window) {
  new ResizeObserver(syncMapPanelHeight).observe(converterPanel);
}

window.addEventListener("resize", syncMapPanelHeight);
