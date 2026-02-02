#!/usr/bin/env python3
"""Convert assessment-based practice pack to item-based format"""

import json

# Load the original
with open("data/practice_packs/week4_payments_v1.json", "r") as f:
    data = json.load(f)

# Map numeric difficulty to string labels
def map_difficulty(num_difficulty):
    mapping = {1: "easy", 2: "easy", 3: "medium", 4: "medium", 5: "hard"}
    return mapping.get(num_difficulty, "medium")

# Convert assessments to items
items = []
for assessment in data.get("assessments", []):
    item = {
        "item_id": assessment.get("assessment_id"),
        "input": assessment.get("prompt"),
        "expected_output": assessment.get("expected_output"),
        "difficulty": map_difficulty(assessment.get("difficulty")),
        "domain": data.get("domain"),
        "tags": assessment.get("metadata", {}).get("tags", []),
        "scoring_criteria": assessment.get("rubric"),
    }
    items.append(item)

# Create new structure
converted = {
    "pack_id": data.get("pack_id"),
    "name": f"{data.get('domain', 'Unknown')} Practice Pack",
    "description": data.get("description"),
    "domain": data.get("domain"),
    "items": items
}

# Save the converted version
with open("data/practice_packs/week4_payments_v1.json", "w") as f:
    json.dump(converted, f, indent=2)

print(f"Converted {len(items)} assessments to items format")
print("File updated: data/practice_packs/week4_payments_v1.json")
