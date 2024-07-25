const monthNames = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

export function returnMonthDay(date) {
    const d = new Date(date);
    return (monthNames[d.getMonth()] + " " + leadingZero(d.getDate()));
}

export function returnTime(date) {
    const d = new Date(date);
    return (leadingZero(d.getHours()) + ":" + leadingZero(d.getMinutes()));
}

export function returnFullDate(date) {
    const d = new Date(date);
    return (leadingZero(d.getMonth() + 1) + "/" + leadingZero(d.getDate()) + "/" + d.getFullYear()) + " at " + returnTime(date);
}

export function leadingZero(value){
    return ('0' + value).slice(-2);
}
