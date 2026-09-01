import SpeedBinb from './templates/SpeedBinb.mjs';

/**
 * COMICメテオ — the old comic-meteor.jp WordPress is gone; the label now
 * lives on the unified きらポ (KiraPo) platform. Listing is server-rendered
 * + one JSON call, episodes are plain rows, and the reader is still
 * SpeedBinb v01.6061 (ptimg) — fully handled by the parent template.
 * Discovered & verified 2026-09 (see scripts/casework/comicmeteor.md).
 */
export default class ComicMeteor extends SpeedBinb {

    /**
     *
     */
    constructor() {
        super();
        super.id = 'comicmeteor';
        super.label = 'COMICメテオ (COMIC Meteor)';
        this.tags = [ 'manga', 'japanese' ];
        this.url = 'https://kirapo.jp/meteor';
    }

    /**
     * Series: /titles?label=<label> renders the first 24 cards plus a
     * data-read-at cursor; /api/title-list returns the whole rest at once.
     */
    _getMangaList( callback ) {
        let request = new Request( 'https://kirapo.jp/titles?label=meteor', this.requestOptions );
        this.fetchDOM( request, 'main' )
            .then( data => {
                let mangaList = [...data[0].querySelectorAll( 'a[href*="/titles/"] img.item-thumbnail' )].map( image => {
                    return {
                        id: new URL( image.closest( 'a' ).getAttribute( 'href' ), request.url ).pathname,
                        title: image.getAttribute( 'alt' ).trim(),
                        thumbnail: image.getAttribute( 'src' )
                    };
                } );
                let readAt = data[0].querySelector( '[data-read-at]' )?.getAttribute( 'data-read-at' );
                if( !readAt ) {
                    return mangaList;
                }
                let api = new Request( 'https://kirapo.jp/api/title-list?label=meteor&read_at=' + encodeURIComponent( readAt ), this.requestOptions );
                return this.fetchJSON( api )
                    .then( json => {
                        for( let item of ( json?.data ?? [] ) ) {
                            if( item.url && item.name && !mangaList.some( manga => manga.id === new URL( item.url ).pathname ) ) {
                                mangaList.push( { id: new URL( item.url ).pathname, title: item.name, thumbnail: item.thumbnail } );
                            }
                        }
                        return mangaList;
                    } )
                    .catch( () => mangaList );
            } )
            .then( data => callback( null, data ) )
            .catch( error => callback( error, undefined ) );
    }

    /**
     *
     */
    _getChapterList( manga, callback ) {
        let request = new Request( new URL( manga.id, this.url ).href, this.requestOptions );
        this.fetchDOM( request, 'div.episodes-container' )
            .then( data => {
                let chapterList = [...data[0].querySelectorAll( 'div.episode-item a.episode-read[href]' )].map( anchor => {
                    let item = anchor.closest( 'div.episode-item' );
                    return {
                        id: this.getRootRelativeOrAbsoluteLink( anchor.getAttribute( 'href' ), request.url ),
                        title: ( item?.querySelector( 'div.fw-bold' )?.textContent ?? anchor.textContent ?? '' ).trim(),
                        language: ''
                    };
                } );
                callback( null, chapterList );
            } )
            .catch( error => callback( error, undefined ) );
    }
}
