const __Seq = require( './seq' )
const Presets = require( './presets.js' )
const Theory  = require( './theory.js' )
const Gibberish = require( 'gibberish-dsp' )

// what properties should be automatically (automagickally?)
// filtered through Audio.Clock.time()?
const __timeProps = {
  Synth:[ 'attack', 'decay', 'sustain', 'release' ],
  PolySynth:[ 'attack', 'decay', 'sustain', 'release' ],
  FM:[ 'attack', 'decay', 'sustain', 'release' ],
  PolyFM:[ 'attack', 'decay', 'sustain', 'release' ],
  Monosynth:[ 'attack', 'decay', 'sustain', 'release' ],
  PolyMono:[ 'attack', 'decay', 'sustain', 'release' ],
  Delay:[ 'time' ], 
}

const Ugen = function( gibberishConstructor, description, Audio ) {

  const Seq = __Seq( Audio )

  const constructor = function( ...args ) {
    const properties = Presets.process( description, args, Audio ) 
    const timeProps = __timeProps[ description.name ] === undefined ? [] : __timeProps[ description.name ]

    for( let key in properties ) {
      if( timeProps.indexOf( key ) > -1 ) {
        properties[ key ] = Audio.Clock.time( properties[ key ] )
      }
    }

    const __wrappedObject = gibberishConstructor( properties )
    const obj = { __wrapped__:__wrappedObject }

    // wrap properties and add sequencing to them
    for( let propertyName in description.properties ) {
      // turn properties into functions. if function is called
      // with no arguments, it acts as a getter. if called with
      // an argument, it acts as a setter.
      obj[ propertyName ] = value => {
        if( value !== undefined ) {

          __wrappedObject[ propertyName ] = timeProps.indexOf( propertyName ) > -1 ? Audio.Clock.time( value ) : value

          // return object for method chaining
          return obj
        }else{
          return __wrappedObject[ propertyName ]
        }
      }

      obj[ propertyName ].sequencers = []
      obj[ propertyName ].seq = function( values, __timings, number=0, delay=0 ) {
        let prevSeq = obj[ propertyName ].sequencers[ number ] 
        if( prevSeq !== undefined ) prevSeq.stop()

        obj[ propertyName ].sequencers[ number ] = Seq({ 
          values, 
          __timings, 
          target:__wrappedObject, 
          key:propertyName 
        })
        .start( Audio.Clock.time( delay ) )
      
        // return object for method chaining
        return obj
      }
    }

    // wrap methods and add sequencing to them
    if( description.methods !== null ) {
      for( let methodName of description.methods ) {
        if( methodName !== 'chord' && methodName !== 'note' ) {
          obj[ methodName ] = __wrappedObject[ methodName ].bind( __wrappedObject )
        }else{
          obj[ methodName ] = function( ...args ) {
            // this should only be for direct calls from the IDE
            if( Gibberish.mode === 'worklet' ) {
              Gibberish.worklet.port.postMessage({
                address:'method',
                object:__wrappedObject.id,
                name:methodName,
                args
              })
            }
          }

          // we have to monkey patch the note method on the Gibberish objects running
          // inside the AudioWorkletProcessor to lookup the index in the current scale.
          if( methodName === 'note' ) {
            Gibberish.worklet.port.postMessage({
              address:'monkeyPatch',
              id:__wrappedObject.id,
              key:'note',
              function:'function( note ){ const __note = Gibberish.Theory.note( note ); this.___note( __note ) }'
            })
          }else{
            Gibberish.worklet.port.postMessage({
              address:'monkeyPatch',
              id:__wrappedObject.id,
              key:'chorus',
              function:'function( notes ){ const __notes = notes.map( Gibberish.Theory.note ); this.___chord( __notes ) }'
            })
          }
        }

        obj[ methodName ].sequencers = []

        obj[ methodName ].seq = function( values, timings, number=0, delay=0 ) {
          let prevSeq = obj[ methodName ].sequencers[ number ] 
          if( prevSeq !== undefined ) prevSeq.stop()

          let s = Seq({ values, timings, target:__wrappedObject, key:methodName })
          
          s.start( Audio.Clock.time( delay ) )
          obj[ methodName ].sequencers[ number ] = s 

          // return object for method chaining
          return obj
        }
      }
    }

    obj.id = __wrappedObject.id

    if( properties !== undefined && properties.shouldAddToUgen ) Object.assign( obj, properties )

    const __fx = []
    __fx.__push = __fx.push.bind( __fx )
    __fx.add = function( ...args ) {
      obj.fx.push( ...args )
      return obj
    }
    obj.fx = new Proxy( __fx, {
      set( target, property, value, receiver ) {

        const lengthCheck = target.length
        target[ property ] = value
        
        if( property === 'length' ) { 
          if( target.length > 1 ) {
            // XXX need to store and reassign to end connection
            target[ target.length - 2 ].disconnect()
            target[ target.length - 2 ].connect( target[ target.length - 1 ] )
            target[ target.length - 1 ].connect()
          }else if( target.length === 1 ) {
            // XXX need to store and reassign
            __wrappedObject.disconnect()
            __wrappedObject.connect( target[ 0 ] )
            target[0].connect( Audio.Master )
          }
        }

        return true
      }
    })

    obj.connect = (dest,level=1) => {
      // if no fx chain, connect directly to output
      if( obj.fx.length === 0 ) {
        __wrappedObject.connect( dest,level ); 
      }else{
        // otherwise, connect last effect in chain to output
        obj.fx[ obj.fx.length - 1 ].__wrapped__.connect( dest, level )
      }

      return obj 
    } 

    obj.disconnect = dest => { __wrappedObject.disconnect( dest ); return obj } 

    if( properties !== undefined && properties.__presetInit__ !== undefined ) {
      properties.__presetInit__.call( obj, Audio )
    }

    // flag will only be present worklet-side, not in the processor.
    /*
    const __flag = true
    if( obj.__wrapped__.onload !== undefined ) {
      const store = obj.__wrapped__.onload
      obj.__wrapped__.onload = function() {
        if( __flag !== undefined ) {
          //store.call( obj )
        }
      } 
    }
    */

    // only connect if shouldNotConneect does not equal true (for LFOs and other modulation sources)
    if( obj.__wrapped__.type === 'instrument' || obj.__wrapped__.type === 'oscillator' ) {
      if( typeof properties !== 'object' || properties.shouldNotConnect !== true ) {
        // ensure that the ugen hasn't already been connected through the fx chain,
        // possibly through initialization of a preset
        if( obj.fx.length === 0 ) obj.connect( Audio.Master )
      }
    }

    return obj
  }
  
  return constructor
}

module.exports = Ugen
