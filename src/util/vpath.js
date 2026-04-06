import path from 'path';
import * as db from '../db/manager.js';

export function getVPathInfo(url, user) {
  // remove leading slashes
  if (url.charAt(0) === '/') {
    url = url.substr(1);
  }

  // Normalize the path to prevent users from using ../ to access files outside of their vpath
  url = path.normalize(url);

  // Get vpath from url
  const vpathName = url.split(path.sep).shift();

  // Verify user has access to this vpath
  if (user && user.vpaths && !user.vpaths.includes(vpathName)) {
    throw new Error(`User does not have access to path ${vpathName}`);
  }

  const library = db.getLibraryByName(vpathName);
  if (!library) {
    throw new Error(`Library '${vpathName}' not found`);
  }

  const baseDir = library.root_path;
  const relPath = path.relative(vpathName, url).replace(/\\/g, '/');
  const fullPath = path.join(baseDir, relPath);

  // Final safety check — resolved path must stay within the library root.
  // path.normalize above should prevent this, but defense-in-depth.
  const resolvedFull = path.resolve(fullPath);
  const resolvedBase = path.resolve(baseDir);
  if (resolvedFull !== resolvedBase && !resolvedFull.startsWith(resolvedBase + path.sep)) {
    throw new Error('Path escapes library root');
  }

  return {
    vpath: vpathName,
    basePath: baseDir,
    relativePath: relPath,
    fullPath: fullPath
  };
}
