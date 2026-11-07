// Shared ordering for Layer Manager and Scene Groups, with visible separators.
export function organizeContextMenu(items) {
  const remaining = (items || []).filter(item => item?.label);
  const sections = [
    /^(Rename|Choose Icon|Change Elevation)/,
    /^(Create |Add Folder|Promote |Convert to |Remove from Scene Group|Ungroup|Dissolve Group|Remove Folder|Make .*Independent)/,
    /^(Nexus Edit|Reset Building Scale|Flatten|.*Mask|Duplicate)/,
    /^(Lock|Unlock|Configure|Settings)/,
    /^Delete/
  ];
  const buckets = sections.map(pattern => remaining.filter(item => pattern.test(item.label)));
  const known = new Set(buckets.flat());
  buckets[2].push(...remaining.filter(item => !known.has(item)));
  const structureOrder = label => /^(Create |Add Folder)/.test(label) ? 0 : /^(Promote |Convert to )/.test(label) ? 1 : 2;
  buckets[1].sort((a,b) => structureOrder(a.label) - structureOrder(b.label));
  const editOrder = label => /^Nexus Edit/.test(label) ? 0 : /^Reset Building/.test(label) ? 1 : /^Flatten/.test(label) ? 2 : /Mask/.test(label) ? 3 : 4;
  buckets[2].sort((a,b) => editOrder(a.label) - editOrder(b.label));
  const result = [];
  for (const bucket of buckets.filter(bucket => bucket.length)) {
    if (result.length) result.push({separator:true});
    result.push(...bucket);
  }
  return result;
}
