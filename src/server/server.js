import Http from 'http';
import Express from 'express';
import _ from 'lodash';
import Path from 'path';
import gen from 'random-seed';
import IoFunction from 'socket.io';

import Game from '../game/game.js';
import Player from '../game/player';

export default class Server {
  constructor(maxPlayers = 16, debug = true, port = 3000, seed = Date.now()) {
    this.expressApp = Express();
    this.httpServer = Http.Server(this.expressApp);
    this.io         = IoFunction(this.httpServer);
    this.port       = port;

    this.gameNS = this.io.of('/game');
    if (debug) {
      this.debugNS = this.io.of('/debug');
      this.createDebugServer();
    }

    this.ns         = '/';
    this.seed       = seed;
    this.sockets = [];
    this.players = [];
    this.maxPlayers = maxPlayers;
    this.game = null;

    this.createServer();
  }

  createServer = () => {
    const PATHS = {
      CLIENT: Path.join(__dirname, '..', 'client'),
      NODE_MODULES: Path.join(__dirname, '..', '..', 'node_modules')
    };
    PATHS.JQUERY = Path.join(PATHS.NODE_MODULES, 'jquery', 'dist');
    PATHS.BOOTSTRAP = Path.join(PATHS.NODE_MODULES, 'bootstrap', 'dist');

    this.expressApp.use(Express.static(PATHS.CLIENT));
    this.expressApp.use('/jquery', Express.static(PATHS.JQUERY));
    this.expressApp.use('/bootstrap', Express.static(PATHS.BOOTSTRAP));

    this.httpServer.listen(this.port, () => {
      console.log(`XANADU SERVER listening on port ${ this.port }`);
    });

    this.gameNS.on('connection', this.handleConnection);
  };

  createDebugServer = () => {
    console.log('Launching the debug server...');
    this.debugNS.on('connection', (socket) => {
      socket.on('get', () => {
        socket.emit('update', this.game.players
          .map(player => player.debugString())
          .join('\n'));
      });
    });
  };

  handleConnection = (socket) => {
    // when people connect...
    if (this.isAcceptingPlayers()) {
      this.acceptSocket(socket);
    } else {
      this.rejectSocket(socket);
    }

    // when people send _anything_ from the client
    socket.on('message', (messageObj) => this.handleMessage(messageObj, socket.id));

    // when people disconnect
    socket.on('disconnect', () => {
      const player = this.getPlayer(socket.id);
      if (player) {
        this.removePlayer(socket.id);
        console.log(`\tRemoved player with id: ${ player.id }`);
        console.log(`user ${ socket.id + '--' + player.name } disconnected`);
        // FIXME: socket/player communication needs to be redone
        socket.broadcast.emit(`${ player.name } has left the game.`);
      } else {
        console.log(`Unrecognized socket ${ socket.id } disconnected`);
      }
    });
  };

  acceptSocket = (socket) => {
    console.log(`Server accepted socket ${ socket.id }`);
    this.sockets.push(socket);
    socket.on('message', (messageObj) => {
      console.log(`Socket ${ socket.id }: ${ messageObj }`);
    });
    this.addPlayer(socket.id);
  };

  rejectSocket = (socket) => {
    console.log(`socket ${ socket.id } rejected -- game full`);
    socket.emit('rejected-from-room');
  };

  isAcceptingPlayers = () => this.players.length < this.maxPlayers;

  addPlayer = (socketId) => {
    this.players.push(new Player({
      id: socketId
    }));
  };

  getPlayer = (socketId) => _.find(this.players, (p) => p.id === socketId);

  removePlayer = (socketId) => {
    this.players = this.players.filter((p) => p.id !== socketId);
  };

  handleMessage = undefined;

  createGame = () => {
    this.game = new Game(this.players, { dimension: 16 }, gen(Date.now()));
  };
}
