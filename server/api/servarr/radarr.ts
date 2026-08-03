import logger from '@server/logger';
import ServarrBase from './base';

export interface RadarrMovieOptions {
  title: string;
  qualityProfileId: number;
  minimumAvailability: string;
  tags: number[];
  profileId: number;
  year: number;
  rootFolderPath: string;
  tmdbId: number;
  monitored?: boolean;
  searchNow?: boolean;
}

export interface RadarrMovie {
  id: number;
  title: string;
  isAvailable: boolean;
  monitored: boolean;
  tmdbId: number;
  imdbId: string;
  titleSlug: string;
  folderName: string;
  path: string;
  profileId: number;
  qualityProfileId: number;
  added: string;
  hasFile: boolean;
  tags: number[];
  movieFile?: {
    id: number;
    movieId: number;
    relativePath?: string;
    path?: string;
    size: number;
    dateAdded: string;
    sceneName?: string;
    releaseGroup?: string;
    edition?: string;
    indexerFlags?: number;
    mediaInfo: {
      id: number;
      audioBitrate: number;
      audioChannels: number;
      audioCodec?: string;
      audioLanguages?: string;
      audioStreamCount: number;
      videoBitDepth: number;
      videoBitrate: number;
      videoCodec?: string;
      videoFps: number;
      videoDynamicRange?: string;
      videoDynamicRangeType?: string;
      resolution?: string;
      runTime?: string;
      scanType?: string;
      subtitles?: string;
    };
    originalFilePath?: string;
    qualityCutoffNotMet: boolean;
  };
}

export interface RadarrHistoryRecord {
  id: number;
  movieId: number;
  sourceTitle?: string;
  downloadId?: string;
  eventType?: string;
  date: string;
}

class RadarrAPI extends ServarrBase<{ movieId: number }> {
  protected addRecoveryPollAttempts = 6;
  protected addRecoveryPollIntervalMs = 1000;

  constructor({ url, apiKey }: { url: string; apiKey: string }) {
    super({ url, apiKey, cacheName: 'radarr', apiName: 'Radarr' });
  }

  private async lookupMovieByTmdbId(id: number): Promise<RadarrMovie | null> {
    const response = await this.axios.get<RadarrMovie[]>('/movie/lookup', {
      params: {
        term: `tmdb:${id}`,
      },
    });

    return response.data[0] ?? null;
  }

  public getMovies = async (): Promise<RadarrMovie[]> => {
    try {
      const response = await this.axios.get<RadarrMovie[]>('/movie');

      return response.data;
    } catch (e) {
      throw new Error(`[Radarr] Failed to retrieve movies: ${e.message}`, {
        cause: e,
      });
    }
  };

  private async findInstalledMovieByTmdbId(
    tmdbId: number
  ): Promise<RadarrMovie | null> {
    const movies = await this.getMovies();
    return movies.find((movie) => movie.tmdbId === tmdbId && movie.id) ?? null;
  }

  private async pollInstalledMovieByTmdbId(
    tmdbId: number
  ): Promise<RadarrMovie | null> {
    for (
      let attempt = 0;
      attempt < this.addRecoveryPollAttempts;
      attempt += 1
    ) {
      const movie = await this.findInstalledMovieByTmdbId(tmdbId);
      if (movie) {
        return movie;
      }
      if (attempt + 1 < this.addRecoveryPollAttempts) {
        await new Promise((resolve) =>
          setTimeout(resolve, this.addRecoveryPollIntervalMs)
        );
      }
    }
    return null;
  }

  private async reconcileRecoveredMovie(
    movie: RadarrMovie,
    options: RadarrMovieOptions
  ): Promise<RadarrMovie> {
    const intendedTags = Array.from(
      new Set([...(movie.tags ?? []), ...options.tags])
    );
    const rootMatches =
      movie.path === options.rootFolderPath ||
      movie.path.startsWith(`${options.rootFolderPath.replace(/\/$/, '')}/`);
    const settingsMatch =
      movie.monitored === options.monitored &&
      movie.qualityProfileId === options.qualityProfileId &&
      movie.profileId === options.profileId &&
      rootMatches &&
      intendedTags.length === (movie.tags ?? []).length;

    if (settingsMatch) {
      return movie;
    }

    const folderName = movie.path.split('/').filter(Boolean).at(-1);
    if (!folderName) {
      throw new Error('Radarr recovered movie has no usable folder name');
    }
    const intendedPath = `${options.rootFolderPath.replace(
      /\/$/,
      ''
    )}/${folderName}`;

    const response = await this.axios.put<RadarrMovie>('/movie', {
      ...movie,
      title: options.title,
      qualityProfileId: options.qualityProfileId,
      profileId: options.profileId,
      minimumAvailability: options.minimumAvailability,
      rootFolderPath: options.rootFolderPath,
      path: intendedPath,
      monitored: options.monitored,
      tags: intendedTags,
    });

    const reconciledRootMatches =
      response.data.path === options.rootFolderPath ||
      response.data.path.startsWith(
        `${options.rootFolderPath.replace(/\/$/, '')}/`
      );
    const reconciledTags = new Set(response.data.tags ?? []);
    if (
      !response.data.id ||
      response.data.tmdbId !== options.tmdbId ||
      response.data.monitored !== options.monitored ||
      response.data.qualityProfileId !== options.qualityProfileId ||
      response.data.profileId !== options.profileId ||
      !reconciledRootMatches ||
      options.tags.some((tag) => !reconciledTags.has(tag))
    ) {
      throw new Error('Radarr did not confirm recovered movie settings');
    }
    return response.data;
  }

  public getMovie = async ({ id }: { id: number }): Promise<RadarrMovie> => {
    try {
      const response = await this.axios.get<RadarrMovie>(`/movie/${id}`);

      return response.data;
    } catch (e) {
      throw new Error(`[Radarr] Failed to retrieve movie: ${e.message}`, {
        cause: e,
      });
    }
  };

  public getMovieHistory = async (
    movieId: number
  ): Promise<RadarrHistoryRecord[]> => {
    try {
      const response = await this.axios.get<
        RadarrHistoryRecord[] | { records?: RadarrHistoryRecord[] }
      >('/history/movie', {
        params: {
          movieId,
        },
      });

      return Array.isArray(response.data)
        ? response.data
        : (response.data.records ?? []);
    } catch (e) {
      throw new Error(
        `[Radarr] Failed to retrieve movie history for ${movieId}: ${e.message}`,
        { cause: e }
      );
    }
  };

  public async getMovieByTmdbId(id: number): Promise<RadarrMovie> {
    let movie: RadarrMovie | null;
    try {
      movie = await this.lookupMovieByTmdbId(id);
    } catch (e) {
      logger.error('Error retrieving movie by TMDB ID', {
        label: 'Radarr API',
        errorMessage: e.message,
        tmdbId: id,
      });
      throw e;
    }

    if (!movie) {
      throw new Error('Movie not found');
    }

    return movie;
  }

  public addMovie = async (
    options: RadarrMovieOptions
  ): Promise<RadarrMovie> => {
    let mutationMayHavePersisted = false;
    try {
      const movie = await this.getMovieByTmdbId(options.tmdbId);

      if (movie.hasFile) {
        logger.info(
          'Title already exists and is available. Skipping add and returning success',
          {
            label: 'Radarr',
            movie,
          }
        );
        return movie;
      }

      // movie exists in Radarr but is neither downloaded nor monitored
      if (movie.id && !movie.monitored) {
        mutationMayHavePersisted = true;
        const response = await this.axios.put<RadarrMovie>(`/movie`, {
          ...movie,
          title: options.title,
          qualityProfileId: options.qualityProfileId,
          profileId: options.profileId,
          titleSlug: options.tmdbId.toString(),
          minimumAvailability: options.minimumAvailability,
          tmdbId: options.tmdbId,
          year: options.year,
          tags: Array.from(new Set([...movie.tags, ...options.tags])),
          rootFolderPath: options.rootFolderPath,
          monitored: options.monitored,
          addOptions: {
            searchForMovie: options.searchNow,
          },
        });
        mutationMayHavePersisted = false;

        if (response.data.monitored) {
          logger.info(
            'Found existing title in Radarr and set it to monitored.',
            {
              label: 'Radarr',
              movieId: response.data.id,
              movieTitle: response.data.title,
            }
          );
          logger.debug('Radarr update details', {
            label: 'Radarr',
            movie: response.data,
          });

          if (options.searchNow) {
            await this.searchMovie(response.data.id);
          }

          return response.data;
        } else {
          logger.error('Failed to update existing movie in Radarr.', {
            label: 'Radarr',
            options,
          });
          throw new Error('Failed to update existing movie in Radarr');
        }
      }

      if (movie.id) {
        // Movie exists and is already monitored
        logger.info('Movie is already monitored in Radarr.', {
          label: 'Radarr',
          movieId: movie.id,
          movieTitle: movie.title,
          hasFile: movie.hasFile,
        });

        // If searchNow is requested and movie doesn't have a file, trigger search
        if (options.searchNow && !movie.hasFile) {
          logger.info(
            'Triggering search for existing monitored movie without file',
            {
              label: 'Radarr',
              movieId: movie.id,
              movieTitle: movie.title,
            }
          );
          await this.searchMovie(movie.id);
        }

        return movie;
      }

      mutationMayHavePersisted = true;
      const response = await this.axios.post<RadarrMovie>(`/movie`, {
        title: options.title,
        qualityProfileId: options.qualityProfileId,
        profileId: options.profileId,
        titleSlug: options.tmdbId.toString(),
        minimumAvailability: options.minimumAvailability,
        tmdbId: options.tmdbId,
        year: options.year,
        rootFolderPath: options.rootFolderPath,
        monitored: options.monitored,
        tags: options.tags,
        addOptions: {
          searchForMovie: options.searchNow,
        },
      });
      mutationMayHavePersisted = false;

      if (response.data.id) {
        logger.info('Radarr accepted request', { label: 'Radarr' });
        logger.debug('Radarr add details', {
          label: 'Radarr',
          movie: response.data,
        });
      } else {
        logger.error('Failed to add movie to Radarr', {
          label: 'Radarr',
          options,
        });
        throw new Error('Failed to add movie to Radarr');
      }
      return response.data;
    } catch (e) {
      try {
        if (!mutationMayHavePersisted) {
          throw e;
        }
        const installedMovie = await this.pollInstalledMovieByTmdbId(
          options.tmdbId
        );

        if (installedMovie) {
          const recoveredMovie = await this.reconcileRecoveredMovie(
            installedMovie,
            options
          );
          logger.warn(
            'Radarr add request failed, but the installed movie was confirmed and reconciled.',
            {
              label: 'Radarr',
              errorMessage: e.message,
              movieId: recoveredMovie.id,
              movieTitle: recoveredMovie.title,
              tmdbId: options.tmdbId,
            }
          );

          logger.debug('Radarr recovered add details', {
            label: 'Radarr',
            movie: recoveredMovie,
          });

          if (options.searchNow && !recoveredMovie.hasFile) {
            await this.searchMovie(recoveredMovie.id);
          }

          return recoveredMovie;
        }
      } catch (lookupError) {
        logger.warn('Radarr add failed and retry lookup did not complete', {
          label: 'Radarr',
          errorMessage:
            lookupError instanceof Error
              ? lookupError.message
              : String(lookupError),
          tmdbId: options.tmdbId,
        });
      }

      logger.error(
        'Failed to add movie to Radarr. This might happen if the movie already exists, in which case you can safely ignore this error.',
        {
          label: 'Radarr',
          errorMessage: e.message,
          options,
          response: e?.response?.data,
        }
      );
      throw new Error('Failed to add movie to Radarr', { cause: e });
    }
  };

  public async searchMovie(movieId: number): Promise<void> {
    logger.info('Executing movie search command', {
      label: 'Radarr API',
      movieId,
    });

    try {
      const response = await this.axios.post<{ id?: number }>('/command', {
        name: 'MoviesSearch',
        movieIds: [movieId],
      });
      if (!response.data?.id) {
        throw new Error('Radarr did not return an accepted command id');
      }
    } catch (e) {
      logger.error(
        'Something went wrong while executing Radarr movie search.',
        {
          label: 'Radarr API',
          errorMessage: e.message,
          movieId,
        }
      );
      throw e;
    }
  }
  public removeMovie = async (tmdbId: number): Promise<void> => {
    const { id, title } = await this.getMovieByTmdbId(tmdbId);

    if (!id) {
      logger.info(`[Radarr] Movie not in library, nothing to remove`, {
        tmdbId,
      });
      return;
    }

    try {
      await this.axios.delete(`/movie/${id}`, {
        params: {
          deleteFiles: true,
          addImportExclusion: false,
        },
      });
      logger.info(`[Radarr] Removed movie ${title}`);
    } catch (e) {
      if (e?.response?.status === 404) {
        logger.info(`[Radarr] Movie already removed from Radarr`, {
          tmdbId,
        });
        return;
      }
      throw e;
    }
  };

  public clearCache = ({
    tmdbId,
    externalId,
  }: {
    tmdbId?: number | null;
    externalId?: number | null;
  }) => {
    if (tmdbId) {
      this.removeCache('/movie/lookup', {
        term: `tmdb:${tmdbId}`,
      });
    }
    if (externalId) {
      this.removeCache(`/movie/${externalId}`);
    }
  };
}

export default RadarrAPI;
