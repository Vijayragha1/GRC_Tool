// Registry of sector overlay packs. Add a new sector by dropping a file in
// this directory and registering it here. Each pack must export:
//   { sector, extraRisks, controlEmphasis, extraMandatoryDocs, notes }
// See data/sector-overlays/healthcare.js for the canonical shape.

const overlays = {
  Healthcare: require('./healthcare'),
};

function getOverlay(sector) {
  if (!sector) return null;
  return overlays[sector] || null;
}

function listAvailable() {
  return Object.keys(overlays);
}

module.exports = { getOverlay, listAvailable };
