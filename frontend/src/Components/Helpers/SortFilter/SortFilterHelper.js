export function filterEntries(tableEntries, filtering) {
    const filteredEntries = tableEntries.filter(entry => {
        const switch_entry = entry.switch_entry;

        // Filter match values
        let includesMatch = true;
        Object.entries(filtering.match_fields).forEach(([key, value]) => {
            if (Array.isArray(value)) {
                if (value[0]) {
                    includesMatch = includesValue(switch_entry.match_fields[key][0], value[0]);
                }
                if (value[1]) {
                    includesMatch = includesValue(switch_entry.match_fields[key][1], value[1]);
                }
            }
            else {
                if (value) {
                    includesMatch = includesValue(switch_entry.match_fields[key], value);
                }
            }
        })
        if (!includesMatch) {
            return false;
        }

        // Filter action name
        if (filtering.action_name && filtering.action_name !== switch_entry.action_name) {
            return false;
        }

        // Filter action params
        if (filtering.action_name == switch_entry.action_name) {
            if (filtering.action_params != null) {
                let includesParams = true
                Object.entries(filtering.action_params).forEach(([param, value]) => {
                    includesParams = includesValue(switch_entry.action_params[param], value);
                })
                if (!includesParams)
                    return false;
            }

        }

        // Check if the priority matches
        if (filtering.priority && filtering.priority !== switch_entry.priority) {
            return false;
        }
        return true;
    });
    return filteredEntries;
}

function includesValue(switch_value, filter_value) {
    switch_value = String(switch_value);
    filter_value = String(filter_value);
    return switch_value.startsWith(filter_value) && switch_value.includes(filter_value);
}


export function sortEntries(tableEntries, sorting) {
    var sortedEntries = JSON.parse(JSON.stringify(tableEntries));
    if (sorting.match_key !== null) {
        sortedEntries.sort((entry_a, entry_b) => {
            const direction = sorting.descending ? 1 : -1;
            if (entry_a.switch_entry.match_fields[sorting.match_key] < entry_b.switch_entry.match_fields[sorting.match_key]) {
                return -1 * direction;
            }
            else if (entry_a.switch_entry.match_fields[sorting.match_key] > entry_b.switch_entry.match_fields[sorting.match_key]) {
                return 1 * direction;
            }
        })
    }
    return sortedEntries;
}