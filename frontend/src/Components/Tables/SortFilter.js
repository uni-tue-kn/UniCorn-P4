import React, { useState } from 'react'

import { entryHandler, sortingHandler } from '../Helpers/HandleHelper';

import { sortFilterInput } from '../Helpers/SortFilter/SortFilterInput'

import { useTable } from '../../Contexts/TableContext'

function SortFilter({ tableName, filtering, setFiltering, sorting, setSorting, needsPriority }) {
  const { tableInfo } = useTable();
  

  console.log(sorting)
  const sortHandler = (event) => {
    const newSorting = sortingHandler(event, sorting);
    setSorting(newSorting);
  }

  const filterHandler = (event) => {
    event.preventDefault();
    const newFiltering = entryHandler(event, filtering, tableInfo, tableName);
    setFiltering(newFiltering);

  }
  return (
    sortFilterInput(tableInfo, tableName, sorting, filtering, sortHandler, filterHandler, needsPriority)
  )
}

export default SortFilter