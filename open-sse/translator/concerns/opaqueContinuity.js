export function stripOpaqueContinuity(value) {
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index--) {
      const item = value[index];
      if (item?.type === "encrypted_content" || item?.type === "reasoning_encrypted_content") {
        value.splice(index, 1);
        continue;
      }
      stripOpaqueContinuity(item);
    }
    return value;
  }
  if (!value || typeof value !== "object") return value;

  for (const key of Object.keys(value)) {
    if (key === "encrypted_content" || key === "reasoning_encrypted_content") {
      delete value[key];
      continue;
    }
    stripOpaqueContinuity(value[key]);
  }
  return value;
}
