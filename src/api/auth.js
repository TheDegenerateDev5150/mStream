import jwt from 'jsonwebtoken';
import Joi from 'joi';
import winston from 'winston';
import * as auth from '../util/auth.js';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import * as shared from '../api/shared.js';
import WebError from '../util/web-error.js';

export function setup(mstream) {
  mstream.post('/api/v1/auth/login', async (req, res) => {
    try {
      const schema = Joi.object({
        username: Joi.string().required(),
        password: Joi.string().required()
      });
      await schema.validateAsync(req.body);

      const user = db.getUserByUsername(req.body.username);
      if (!user) { throw new Error('user not found'); }

      await auth.authenticateUser(user.password, user.salt, req.body.password);

      const token = jwt.sign({ username: req.body.username }, config.program.secret);

      res.cookie('x-access-token', token, {
        maxAge: 157784630000, // 5 years in ms
        sameSite: 'Strict',
      });

      // Get user's library names for the response
      const libIds = db.getUserLibraryIds(user);
      const libraries = db.getAllLibraries().filter(l => libIds.includes(l.id));
      const vpaths = libraries.map(l => l.name);

      res.json({ vpaths, token });
    } catch (err) {
      winston.warn(`Failed login attempt from ${req.ip}. Username: ${req.body.username}`, { stack: err });
      setTimeout(() => { res.status(401).json({ error: 'Login Failed' }); }, 800);
    }
  });

  mstream.use((req, res, next) => {
    const allUsers = db.getAllUsers();

    // Handle No Users (public access mode)
    if (allUsers.length === 0) {
      const allLibs = db.getAllLibraries();
      req.user = {
        vpaths: allLibs.map(l => l.name),
        username: 'mstream-user',
        admin: true,
        id: null
      };
      return next();
    }

    const token = req.body?.token || req.query?.token || req.headers?.['x-access-token'] || req.cookies?.['x-access-token'];
    if (!token) { throw new WebError('Authentication Error', 401); }
    req.token = token;

    const decoded = jwt.verify(token, config.program.secret);

    // Handle federation invite tokens
    if (decoded.invite && decoded.invite === true) {
      if (req.path === '/federation/invite/exchange') { return next(); }
      throw new WebError('Authentication Error', 401);
    }

    // Handle jukebox tokens
    if (decoded.jukebox === true && decoded.username) {
      const user = db.getUserByUsername(decoded.username);
      if (!user) { throw new WebError('Authentication Error', 401); }
      const libIds = db.getUserLibraryIds(user);
      const libraries = db.getAllLibraries().filter(l => libIds.includes(l.id));
      req.user = {
        ...user,
        vpaths: libraries.map(l => l.name),
        admin: user.is_admin === 1
      };
      return next();
    }

    if (!decoded.username) {
      throw new WebError('Authentication Error', 401);
    }

    const user = db.getUserByUsername(decoded.username);
    if (!user) {
      throw new WebError('Authentication Error', 401);
    }

    // Build user object with vpaths
    const libIds = db.getUserLibraryIds(user);
    const libraries = db.getAllLibraries().filter(l => libIds.includes(l.id));
    req.user = {
      ...user,
      vpaths: libraries.map(l => l.name),
      admin: user.is_admin === 1
    };

    // Handle Shared Tokens
    if (decoded.shareToken && decoded.shareToken === true) {
      const playlistItem = shared.lookupPlaylist(decoded.playlistId);

      if (
        req.path !== '/api/v1/download/shared' &&
        req.path !== '/api/v1/db/metadata' &&
        req.path.substring(0, 11) !== '/album-art/' &&
        playlistItem.playlist.indexOf(decodeURIComponent(req.path).slice(7)) === -1
      ) {
        throw new WebError('Authentication Error', 401);
      }

      req.sharedPlaylistId = decoded.playlistId;
    }

    next();
  });
}
