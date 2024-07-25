export function entryHandler(event, entryData, tableInfo, tableName) {
    // match value(s), action name or action params
    const fieldName = event.target.name;
    // passed values
    const fieldValue = event.target.value;
    // specific match key or parameter name
    const fieldId = event.target.id;
    // copy old data
    const newEntryData = { ... entryData };

    switch (fieldName) {
        case "match_value":
            newEntryData.match_fields[fieldId] = fieldValue;
            break;
        case "match_value1":
            // create new array for match key if it does not exist already
            newEntryData.match_fields[fieldId] = newEntryData.match_fields[fieldId] || [];
            newEntryData.match_fields[fieldId][0] = fieldValue;
            break;
        case "match_value2":
            // create new array for match key if it does not exist already
            newEntryData.match_fields[fieldId] = newEntryData.match_fields[fieldId] || [];
            if (tableInfo[tableName].match_fields[fieldId].match_type === 3){
                newEntryData.match_fields[fieldId][1] = +fieldValue;
              }
            else {
                newEntryData.match_fields[fieldId][1] = fieldValue;
            }
            break;
        case "action_name":
            if (newEntryData.action_name != fieldValue) {
                // reset action params when new action was selected
                newEntryData.action_params = null;
                newEntryData.action_name = fieldValue;
              }
              break;
        case "action_param":
            // create new object for action params if it does not exist already
            newEntryData.action_params = newEntryData.action_params || {};
            newEntryData.action_params[fieldId] = fieldValue;
            break;
        case "priority":
            newEntryData.priority = +fieldValue;
            break;    
    }

    return newEntryData;
} 

export function sortingHandler(event, sorting) {
    
    const newSorting = { ...sorting };
    if (event.target.name === "match_key") {
        const match_key = event.target.value;
        newSorting.match_key = match_key;
    }
    else {
        newSorting.descending = !sorting.descending;
    }
    return newSorting;
}

