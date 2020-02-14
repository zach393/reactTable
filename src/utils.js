import React from 'react'
import { defaultColumn, reduceHooks } from './publicUtils'

// Find the depth of the columns
export function findMaxDepth(columns, depth = 0) {
  return columns.reduce((prev, curr) => {
    if (curr.columns) {
      return Math.max(prev, findMaxDepth(curr.columns, depth + 1))
    }
    return depth
  }, 0)
}

// Build the visible columns, headers and flat column list
export function linkColumnStructure(columns, parent, depth = 0) {
  return columns.map(column => {
    column = {
      ...column,
      parent,
      depth,
    }

    assignColumnAccessor(column)

    if (column.columns) {
      column.columns = linkColumnStructure(column.columns, column, depth + 1)
    }
    return column
  })
}

export function flattenColumns(columns) {
  return flattenBy(columns, 'columns')
}

export function assignColumnAccessor(column) {
  // First check for string accessor
  let { id, accessor, Header } = column

  if (typeof accessor === 'string') {
    id = id || accessor
    const accessorPath = accessor.split('.')
    accessor = row => getBy(row, accessorPath)
  }

  if (!id && typeof Header === 'string' && Header) {
    id = Header
  }

  if (!id && column.columns) {
    console.error(column)
    throw new Error('A column ID (or unique "Header" value) is required!')
  }

  if (!id) {
    console.error(column)
    throw new Error('A column ID (or string accessor) is required!')
  }

  Object.assign(column, {
    id,
    accessor,
  })

  return column
}

// Find the depth of the columns
export function dedupeBy(arr, fn) {
  return [...arr]
    .reverse()
    .filter((d, i, all) => all.findIndex(dd => fn(dd) === fn(d)) === i)
    .reverse()
}

export function decorateColumn(column, userDefaultColumn) {
  if (!userDefaultColumn) {
    throw new Error()
  }
  Object.assign(column, {
    // Make sure there is a fallback header, just in case
    Header: () => <>&nbsp;</>,
    Footer: () => <>&nbsp;</>,
    ...defaultColumn,
    ...userDefaultColumn,
    ...column,
  })
  return column
}

export function accessRowsForColumn({
  data,
  rows,
  flatRows,
  rowsById,
  column,
  getRowId,
  getSubRows,
  accessValueHooks,
  getInstance,
}) {
  // Access the row's data column-by-column
  // We do it this way so we can incrementally add materialized
  // columns after the first pass and avoid excessive looping
  const accessRow = (originalRow, rowIndex, depth = 0, parent, parentRows) => {
    // Keep the original reference around
    const original = originalRow

    const id = getRowId(originalRow, rowIndex, parent)

    let row = rowsById[id]

    // If the row hasn't been created, let's make it
    if (!row) {
      row = {
        id,
        original,
        index: rowIndex,
        depth,
        cells: [{}], // This is a dummy cell
      }

      // Override common array functions (and the dummy cell's getCellProps function)
      // to show an error if it is accessed without calling prepareRow
      row.cells.map = unpreparedAccessWarning
      row.cells.filter = unpreparedAccessWarning
      row.cells.forEach = unpreparedAccessWarning
      row.cells[0].getCellProps = unpreparedAccessWarning

      // Create the cells and values
      row.values = {}

      // Push this row into the parentRows array
      parentRows.push(row)
      // Keep track of every row in a flat array
      flatRows.push(row)
      // Also keep track of every row by its ID
      rowsById[id] = row

      // Get the original subrows
      row.originalSubRows = getSubRows(originalRow, rowIndex)

      // Then recursively access them
      if (row.originalSubRows) {
        const subRows = []
        row.originalSubRows.forEach((d, i) =>
          accessRow(d, i, depth + 1, row, subRows)
        )
        // Keep the new subRows array on the row
        row.subRows = subRows
      }
    } else if (row.subRows) {
      // If the row exists, then it's already been accessed
      // Keep recursing, but don't worry about passing the
      // accumlator array (those rows already exist)
      row.originalSubRows.forEach((d, i) => accessRow(d, i, depth + 1, row))
    }

    // If the column has an accessor, use it to get a value
    if (column.accessor) {
      row.values[column.id] = column.accessor(originalRow, rowIndex, row)
    }

    // Allow plugins to manipulate the column value
    row.values[column.id] = reduceHooks(
      accessValueHooks,
      row.values[column.id],
      {
        row,
        column,
        instance: getInstance(),
      },
      true
    )
  }

  data.forEach((originalRow, rowIndex) =>
    accessRow(originalRow, rowIndex, 0, undefined, rows)
  )
}

// Build the header groups from the bottom up
export function makeHeaderGroups(allColumns, defaultColumn) {
  const headerGroups = []

  let scanColumns = allColumns

  let uid = 0
  const getUID = () => uid++

  while (scanColumns.length) {
    // The header group we are creating
    const headerGroup = {
      headers: [],
    }

    // The parent columns we're going to scan next
    const parentColumns = []

    const hasParents = scanColumns.some(d => d.parent)

    // Scan each column for parents
    scanColumns.forEach(column => {
      // What is the latest (last) parent column?
      let latestParentColumn = [...parentColumns].reverse()[0]

      let newParent

      if (hasParents) {
        // If the column has a parent, add it if necessary
        if (column.parent) {
          newParent = {
            ...column.parent,
            originalId: column.parent.id,
            id: `${column.parent.id}_${getUID()}`,
            headers: [column],
          }
        } else {
          // If other columns have parents, we'll need to add a place holder if necessary
          const originalId = `${column.id}_placeholder`
          newParent = decorateColumn(
            {
              originalId,
              id: `${column.id}_placeholder_${getUID()}`,
              placeholderOf: column,
              headers: [column],
            },
            defaultColumn
          )
        }

        // If the resulting parent columns are the same, just add
        // the column and increment the header span
        if (
          latestParentColumn &&
          latestParentColumn.originalId === newParent.originalId
        ) {
          latestParentColumn.headers.push(column)
        } else {
          parentColumns.push(newParent)
        }
      }

      headerGroup.headers.push(column)
    })

    headerGroups.push(headerGroup)

    // Start scanning the parent columns
    scanColumns = parentColumns
  }

  return headerGroups.reverse()
}

const pathObjCache = new Map()

export function getBy(obj, path, def) {
  if (!path) {
    return obj
  }
  const cacheKey = typeof path === 'function' ? path : JSON.stringify(path)

  const pathObj =
    pathObjCache.get(cacheKey) ||
    (() => {
      const pathObj = makePathArray(path)
      pathObjCache.set(cacheKey, pathObj)
      return pathObj
    })()

  let val

  try {
    val = pathObj.reduce((cursor, pathPart) => cursor[pathPart], obj)
  } catch (e) {
    // continue regardless of error
  }
  return typeof val !== 'undefined' ? val : def
}

export function getFirstDefined(...args) {
  for (let i = 0; i < args.length; i += 1) {
    if (typeof args[i] !== 'undefined') {
      return args[i]
    }
  }
}

export function getElementDimensions(element) {
  const rect = element.getBoundingClientRect()
  const style = window.getComputedStyle(element)
  const margins = {
    left: parseInt(style.marginLeft),
    right: parseInt(style.marginRight),
  }
  const padding = {
    left: parseInt(style.paddingLeft),
    right: parseInt(style.paddingRight),
  }
  return {
    left: Math.ceil(rect.left),
    width: Math.ceil(rect.width),
    outerWidth: Math.ceil(
      rect.width + margins.left + margins.right + padding.left + padding.right
    ),
    marginLeft: margins.left,
    marginRight: margins.right,
    paddingLeft: padding.left,
    paddingRight: padding.right,
    scrollWidth: element.scrollWidth,
  }
}

export function isFunction(a) {
  if (typeof a === 'function') {
    return a
  }
}

export function flattenBy(arr, key) {
  const flat = []

  const recurse = arr => {
    arr.forEach(d => {
      if (!d[key]) {
        flat.push(d)
      } else {
        recurse(d[key])
      }
    })
  }

  recurse(arr)

  return flat
}

export function expandRows(
  rows,
  { manualExpandedKey, expanded, expandSubRows = true }
) {
  const expandedRows = []

  const handleRow = row => {
    row.isExpanded =
      (row.original && row.original[manualExpandedKey]) || expanded[row.id]

    row.canExpand = row.subRows && !!row.subRows.length

    expandedRows.push(row)

    if (expandSubRows && row.subRows && row.subRows.length && row.isExpanded) {
      row.subRows.forEach(handleRow)
    }
  }

  rows.forEach(handleRow)

  return expandedRows
}

export function getFilterMethod(filter, userFilterTypes, filterTypes) {
  return (
    isFunction(filter) ||
    userFilterTypes[filter] ||
    filterTypes[filter] ||
    filterTypes.text
  )
}

export function shouldAutoRemoveFilter(autoRemove, value, column) {
  return autoRemove ? autoRemove(value, column) : typeof value === 'undefined'
}

export function unpreparedAccessWarning() {
  throw new Error(
    'React-Table: You have not called prepareRow(row) one or more rows you are attempting to render.'
  )
}

//

const reOpenBracket = /\[/g
const reCloseBracket = /\]/g

function makePathArray(obj) {
  return (
    flattenDeep(obj)
      // remove all periods in parts
      .map(d => String(d).replace('.', '_'))
      // join parts using period
      .join('.')
      // replace brackets with periods
      .replace(reOpenBracket, '.')
      .replace(reCloseBracket, '')
      // split it back out on periods
      .split('.')
  )
}

function flattenDeep(arr, newArr = []) {
  if (!Array.isArray(arr)) {
    newArr.push(arr)
  } else {
    for (let i = 0; i < arr.length; i += 1) {
      flattenDeep(arr[i], newArr)
    }
  }
  return newArr
}
