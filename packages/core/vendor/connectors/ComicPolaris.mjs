import SpeedBinb from './templates/SpeedBinb.mjs';

/**
 * COMICポラリス — old comic-polaris.jp WordPress is gone; the label now
 * lives on the unified きらポ (KiraPo) platform (same migration as
 * COMICメテオ). Listing + episodes are plain markup, the reader stays
 * SpeedBinb v01.6061 (ptimg) — handled by the parent template.
 * Verified 2026-09 (see scripts/casework/comicpolaris.md).
 */
export default class ComicPolaris extends SpeedBinb {

    /**
     *
     */
    constructor() {
        super();
        super.id = 'comicpolaris';
        super.label = 'COMICポラリス (COMIC Polaris)';
        this.tags = [ 'manga', 'japanese' ];
        this.url = 'https://kirapo.jp/polaris';
    }

    /**
     * Series: /titles?label=polaris renders the first cards plus a
     * data-read-at cursor; /api/title-list returns the rest at once.
     */
    _getMangaList( callback ) {
        let request = new Request( 'https://kirapo.jp/titles?label=polaris', this.requestOptions );
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
                let api = new Request( 'https://kirapo.jp/api/title-list?label=polaris&read_at=' + encodeURIComponent( readAt ), this.requestOptions );
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
